# Architecture

## Processes

```text
                     ┌──────────────────────────────┐
   browser  ─────────┤ nginx (TLS) │
                     └───┬──────────┬───────────┬───┘
                         │ /        │ /api      │ /collab
                         │ /realtime│           │
                 ┌───────▼───┐  ┌───▼────────┐  ┌▼─────────────────┐
                 │ apps/web  │  │ apps/api   │  │ apps/collaboration│
                 │ Next.js   │  │ NestJS +   │  │ Hocuspocus        │
                 │           │  │ Fastify    │  │                   │
                 └───────────┘  └───┬────────┘  └───┬───────────────┘
                                    │               │
                             ┌──────▼───────────────▼──────┐
                             │ PostgreSQL · Redis · MinIO   │
                             └──────▲───────────────────────┘
                                    │
                             ┌──────┴─────┐
                             │ apps/worker│  BullMQ
                             └────────────┘
```

Four long-running Node processes, deliberately separate:

- **web** renders the UI. It never touches PostgreSQL, Redis, object storage or any
  secret. Everything goes through the API on the same origin.
- **api** owns business logic, authentication, authorization and the application
  realtime channel.
- **collaboration** serves only the Yjs protocol. A crash in the editing hot path
  cannot take the REST API down, and it can be scaled independently.
- **worker** performs everything expensive: materialization, search indexing, AI
  runs, rendering, project builds, maintenance. No request handler ever does this
  work inline. It is also the only process allowed to start a container.

`apps/mcp` is the fifth application in the repository and the exception to the
picture above: it is not a service but a stdio binary an external client (Claude
Code, Hermes) starts for itself, and it reaches the domain through the same REST
API over loopback. The second MCP transport, `POST /api/mcp`, is served by the
API and shares the protocol dispatcher with it (ADR-018). Both reach exactly one
tool catalogue, `packages/mcp-tools`, which is also what the built-in AI's tool
loop in the worker calls (ADR-014, ADR-025). See `docs/mcp.md`.

## Request and data flow of an edit

1. The browser asks the API for a collaboration ticket
   (`POST /api/documents/:id/collaboration-ticket`). The API resolves the caller's
   workspace role, derives the access mode from the policy layer and returns a
   signed, short-lived, single-document ticket.
2. The browser connects to the collaboration server with that ticket. The server
   verifies the signature, the expiry and the document scope, then **re-checks**
   workspace membership and archival state and takes the _minimum_ of the ticket
   claim and the current policy decision.
3. Edits flow as Yjs updates. `y-indexeddb` keeps a local copy, so the editor works
   offline and resynchronizes on reconnect.
4. Hocuspocus debounces and calls the `Database` extension's `store` hook. The
   binary state is written verbatim to `DocumentContent.yjsState` (ADR-005).
5. `store` also enqueues a debounced `document-materialization` job.
6. The worker derives ProseMirror JSON, plain text and Markdown, writes them next
   to the canonical state, enqueues `search-indexing`, and publishes
   `document.materialized` plus `job.progress` events.
7. The API's event-bus subscriber re-emits those events into the Socket.IO rooms of
   the workspace. The UI updates the tree, the properties panel and the progress
   indicator.

## Two sockets, on purpose

| Channel       | Path        | Transport      | Payload                                   |
| ------------- | ----------- | -------------- | ----------------------------------------- |
| collaboration | `/collab`   | Hocuspocus/Yjs | document updates, awareness, edit notices |
| application   | `/realtime` | Socket.IO      | domain events, job progress, AI streaming |

Awareness is never persisted. Domain events never travel over the Yjs protocol
(ADR-008).

One kind of message rides the collaboration socket that is not a Yjs update:
the edit notice (ADR-065). After a write that did not come from the editor
(`POST /internal/documents/:id/content`, ADR-016), the collaboration server
compares the live page before and after and broadcasts a Hocuspocus stateless
message naming the changed blocks and the writer, which the editor turns into a
marker that settles after a few seconds (`agent-edit-markers.tsx`). It is not a
domain event: it is about this document's content only, it reaches exactly the
connections that read the document, it arrives behind the update it describes,
and it is never stored.

Both are authorized once, when they open, and then live as long as the tab does.
A third Redis channel exists for exactly that reason: `exocortex:revocations`
carries `{ userId, workspaceId | null, reason }` to every process holding such a
connection, so a removed member leaves the workspace room and a demoted editing
session loses `write` without waiting for a reconnect. It is deliberately not the
application event bus (that one fans out into browser rooms) and deliberately not
the outbox (a poll is too slow for an authorization decision); the guarantee
underneath it is a periodic re-authorization sweep in both processes. ADR-029 and
`docs/security.md` have the whole picture.

## Reliability: outbox plus best-effort realtime

Domain mutations write an `OutboxEvent` row **inside the same transaction** as the
state change. The `dispatch-outbox` maintenance job turns those rows into follow-up
work and marks them processed; a failure records `attempts` and `lastError` and is
retried, never dropped.

Four kinds of follow-up hang off it, and they hang off it for one reason: this is
the single place every domain event passes exactly once.

| Follow-up                  | For which events                                       | Written up in             |
| -------------------------- | ------------------------------------------------------ | ------------------------- |
| search indexing            | everything carrying a `documentId`                     | this document, below      |
| `resolve-document-links`   | `document.created`, `.updated` (rename only), `.moved` | `docs/background-jobs.md` |
| automations (ADR-024)      | every event, matched against the workspace's rules     | `docs/automations.md`     |
| overview refresh (ADR-028) | page changes under an overview page, debounced         | `docs/overview-pages.md`  |

A workspace with no rules and no overview page pays one cached settings read per
event for the last two and nothing else.

The realtime emit that happens right after the transaction is a fast path. If it
fails it is logged and the request still succeeds — correctness comes from the
outbox, latency comes from the socket (ADR-010).

## Authorization

Every workspace-scoped operation:

1. loads the caller's role with `WorkspaceAccessService` (a client-provided
   `workspaceId` is never trusted on its own),
2. asserts a pure policy from `packages/auth/src/policies.ts`,
3. and only then performs the work.

Policies are pure functions with no database access, so they are exhaustively unit
tested (26 tests in `packages/auth/src/policies.test.ts`).

## Document hierarchy

- `parentId` gives arbitrary nesting.
- `orderKey` is a base62 fractional index. Inserting between two siblings generates
  a key strictly between theirs and touches no other row
  (`packages/database/src/order-key.ts`, 11 tests including 500 sequential and 200
  same-position insertions).
- Cross-workspace parents are rejected (`document_cross_workspace`).
- Circular moves are rejected (`document_move_cycle`), checked over the whole
  subtree inside the move transaction.
- Archiving a page archives its subtree, so no editable page can hang under an
  archived parent.
- The trash keeps that subtree (`GET /api/workspaces/:id/trash`, issue #32):
  `parentId` survives archiving, and one archive operation stamps every page it
  takes with the same `archivedAt`, so "was this chosen or did it come along"
  is derived, never recorded a second time.
- Deleting a page for good (`DELETE /api/documents/:id`, issue #31) needs the
  page to be archived first and the ADMIN role, and it is the only operation in
  the application that nothing undoes. Content, snapshots, the search
  projection, embeddings, comments and property values go with it through the
  foreign keys; references _to_ the page become unresolved rather than
  disappearing, and its files are removed from object storage after the
  transaction commits, because storage has no transaction to join.
- Moves, archives, restores, snapshot restores, attachment deletions and permission
  changes write an `AuditLog` entry. Audit metadata never contains document content.
- `layout` (`NARROW` / `WIDE` / `FULL`) is the width of the page body: the 68ch
  reading measure, roughly twice that, or the whole available width. It is
  presentation, so it lives on the document row and not in the Yjs state, and it
  is edited in the page properties dialog
  (`apps/web/src/components/document/page-properties-dialog.tsx`) or through
  `exo_page_set_layout`. New databases default to `FULL`, new pages to `NARROW`.
  The three values only set `--page-measure` in `globals.css`; blocks that carry
  a layout of their own (a database embed) break out of the measure regardless.
  None of them touches the interaction gutter, the strip left of every block
  that the editor's own controls sit in (`docs/ui-system.md`): it is reserved as
  page padding outside the measure, so a `full` page has one too.
- `coverAttachmentId` / `coverPosition` are the page's cover image: an ordinary
  image `Attachment` shown full width above the title at a fixed height, cropped
  with `object-fit: cover`, plus the vertical offset in percent that decides
  which slice of it that is. Presentation again, so it sits on the document row;
  it is edited on the page itself
  (`apps/web/src/components/document/page-cover.tsx`) or through
  `exo_page_set_cover`, and it travels in the Markdown frontmatter (`cover`,
  `coverPosition`) because it is page metadata and not a block (ADR-007).
  `POST /api/documents/:id/cover` uploads and sets in one call and marks the
  file cover-only; the `collect-orphaned-covers` maintenance task deletes such
  a file once nothing points at it any more.
  `POST /api/documents/:id/cover/generate` is the other way to get one: it
  queues a `document-cover` job that draws the picture from a prompt and then
  installs it through the upload route above, so the generated file is subject
  to the same checks. See `docs/ai-architecture.md` for the generator.

## Image attachments have two objects

Every uploaded image whose original is over 400 KB also gets a downscaled WebP
copy, fitted inside 2048 px and stored beside the original at
`<key>.preview.webp` (`previewKey` / `previewMimeType` / `previewByteSize` on
`Attachment`, built by `createImagePreview` in `packages/storage`). The
downscaling happens inside the upload request rather than in a job, because the
preview exists to make the _first_ render cheap and a cover that was just set is
rendered immediately; libvips runs it off the event loop and the input is
bounded by `MAX_UPLOAD_BYTES`.

`GET /api/attachments/:id/download?variant=preview` serves that copy and falls
back to the original when there is none, so a renderer can ask for it
unconditionally. Page covers and database gallery thumbnails do; the image block
in the editor keeps the plain URL, because that URL is stored in the document
content and the display decision does not belong there. Deleting an attachment
deletes both objects, and so does the orphaned-cover sweep. Vector and animated
formats (SVG, GIF, multi-frame WebP) are never re-encoded; re-encoding also
strips EXIF, so a photo's GPS coordinates never reach the browser through the
preview.

## Databases

A database is a `Document` with `type: 'COLLECTION'`; its rows are ordinary
`Document`s (`type: 'PAGE'`) parented under it, so a row gets the tree,
search indexing, trash, Yjs content and authorization above for free
(ADR-011). Full recipe and file map: `docs/database-views.md`.

The one piece worth calling out here is the query engine
(`packages/database/src/database-query.ts`): filters and sorts arrive as a
structured, zod-validated tree, never as SQL or an expression string. Before
compiling it, the service loads the real `DatabaseProperty` rows for the
collection being queried and rejects any `propertyId` that is not one of
them — closing off the possibility of referencing a property from a
different collection (or workspace) to probe its data. Which
`document_property_value` column a condition compares against is chosen in
code from that property's type, never taken from the request, so the one
place this code touches `Prisma.raw` only ever receives one of five
hardcoded column-name literals.

## Search

`SearchAdapter` (`packages/database/src/search.ts`) is the only interface the
application uses. `PostgresSearchAdapter` combines:

- a generated, weighted `tsvector` (title weight A, body weight B) with a GIN index,
- trigram similarity on the title for typo tolerance,
- `ts_headline` for highlighted snippets,
- a hard workspace filter in SQL.

Adding OpenSearch means adding a second implementation.

`HybridSearchAdapter` (`packages/database/src/semantic-search.ts`) is the second
one, and it wraps the first (ADR-020). It writes a vector per document into
`DocumentEmbedding` as it indexes, searches `pgvector` for nearest neighbours
alongside the full-text query, and fuses the two lists by reciprocal rank. It is
what both composition roots build; `search.semanticEnabled` decides per call
whether the second half runs at all, and with it off the behaviour is exactly
`PostgresSearchAdapter`'s.

A page above 2400 characters gets passage vectors as well, one per run of blocks
of about 2000 characters (`packages/database/src/chunking.ts`, ADR-034). They
are stored under `blockId = 'chunk:NNNN'` beside the whole-document row, with
the passage in `chunkText`; the vector query over-samples and folds the nearest
rows to the best one per page before fusion, and that row's passage becomes the
excerpt a reader and `recall` see. `findRelated` reads whole-document rows only,
which is why they survived.

The vectors come from `EmbeddingProvider` in `packages/ai`, which
`packages/database` may not import — the adapter declares its own
`EmbeddingClient` port and the composition root passes the bridge
(`createEmbeddingClient`).

## References between pages

`DocumentLink` is the index behind the Verweise panel, `exo_page_backlinks` and
`GET /api/documents/:id/links`. It is derived data, written by the
materialization pass that also derives Markdown and plain text (ADR-007) and
replaced wholesale per source page, so a reference deleted from the text
disappears from the index.

A reference can address its target two ways, and the index carries both
(issue #14). `targetHintId` is the identity written in the document itself —
a `pageLink` block's `documentId`, a page mention's `id` — and it is tried
first, which is what makes renaming a page a non-event for every reference
made through the page picker. `targetTitleKey` carries the normalized title
and answers for the notations that have nothing else: a `[[Titel]]` link mark,
an import that has not been bound yet, a link made before identities existed.
`targetDocumentId` is the _resolved_ pointer either produced, and it is
nullable because a reference to a page that does not exist is kept, not
discarded.

The title half can still go stale from the _target_ side — a page renamed while
nothing about the referencing page changed — so a rename, a creation and a
workspace move each enqueue a `resolve-document-links` maintenance job through
the outbox (ADR-010). See `docs/background-jobs.md` for the two jobs and why
neither of them is a sweep.

A reference to a title no page carries is kept, not discarded. It is the one
thing the panel can tell someone that nothing else in the application reveals.

## The rest of the system

Everything above is the substrate: processes, events, the tree, search. The
subsystems built on top of it each have their own document, and this is the
index so nothing has to be found by grep.

| Subsystem           | What it is                                                          | Read                        |
| ------------------- | ------------------------------------------------------------------- | --------------------------- |
| databases and views | a `COLLECTION` page, rows as pages, four view types (ADR-011)       | `docs/database-views.md`    |
| the tool catalogue  | one catalogue over stdio MCP, `POST /api/mcp` and the built-in AI   | `docs/mcp.md`               |
| capability parity   | the browser, the AI and MCP reach the same routes (ADR-025)         | `docs/capability-matrix.md` |
| the built-in AI     | providers, runs, tools, page context, budgets                       | `docs/ai-architecture.md`   |
| agent memory        | its own workspace, facts above notes (ADR-019, ADR-021)             | `docs/background-jobs.md`   |
| settings            | four resolution layers, per-workspace overrides, ceilings (ADR-023) | `docs/admin.md`             |
| automations         | rules fired from the outbox, refusing by default (ADR-024)          | `docs/automations.md`       |
| rendering           | Markdown to PDF through Pandoc in a container (ADR-026)             | `docs/render.md`            |
| projects            | a `PROJECT` page whose Yjs state is a file tree (ADR-027)           | `docs/projects.md`          |
| overview pages      | text composed from the children's digests (ADR-028)                 | `docs/overview-pages.md`    |
| saved queries       | one stored question, three surfaces, no stored answer (ADR-042)     | `docs/saved-queries.md`     |
| work items          | delegated work with a history; a run is one attempt (ADR-066)       | `docs/work-items.md`        |

Entities (issue #47) have no document of their own: an entity is a row in an
ordinary database, its mentions are written by the materialization pass, and
`entity-rescan` looks one new name up across the pages that already exist.

## Adding things

### A new WebSocket event

1. add the name to `APPLICATION_EVENT_TYPES` in
   `packages/contracts/src/events.ts` and an `envelope(...)` entry with its payload
   schema,
2. emit it with `RealtimeService.emit(...)` from a service (or
   `RedisEventBus.publish(...)` from the worker),
3. consume it in the UI with `useRealtimeEvent('your.event', …)`,
4. if the event must survive a delivery failure, also write an outbox row inside
   the transaction.

Rooms are derived server-side (`workspaceRoom(workspaceId)`); clients only ever
send a `workspaceId` and every subscription is authorized. A subscription can
also be taken away again while the socket stays open: the server sends
`exocortex.subscription.revoked`, and the browser answers by subscribing again
(ADR-029).

### A new storage backend

Implement `ObjectStorage` (`packages/storage/src/object-storage.ts`) and provide it
in `apps/api/src/platform/platform.module.ts`. Object keys must stay
server-derived (`buildAttachmentKey`); clients never choose keys.

### A new REST endpoint

1. define request and response schemas in `packages/contracts`,
2. add a method to the relevant service, including the policy assertion,
3. add a thin controller method with `zodPipe(schema)` and
   `openApiSchema(schema)` so validation and OpenAPI come from the same source.

### Deleting a workspace

There is no REST endpoint for it, deliberately: a route that erases a
workspace, every page under it and every uploaded file is a route a session can
reach. It is an operator task instead —
`apps/api/scripts/delete-workspaces.ts` (`pnpm --filter @exocortex/api
workspaces:delete -- --id <id> [--dry-run]`), which removes the stored objects
first, while the rows that name them still exist, and then deletes the one row
everything else cascades from.

The browser suite is its main caller: it creates a workspace per scenario,
notes each id in `e2e/.created-workspaces`, and `e2e/support/global-teardown.ts`
hands the list to the script when the run ends. Without that the deployment
fills up — it reached 136 leftover workspaces before anyone noticed, at which
point the workspace menu was unusable. A cleanup that fails never fails the
run; the ids stay in the file for a manual sweep.

### Obsidian import

`apps/api/scripts/import-obsidian.ts` (`pnpm --filter @exocortex/api
import:obsidian`) imports a folder tree of Markdown notes into a workspace:
folders become root-and-nested `PAGE` documents, notes become `PAGE` documents
underneath them, and `[[wikilinks]]` become internal links. It is an operator
task, not a user action, so it writes through `@exocortex/database` and
`@exocortex/queue` directly instead of the REST API (609 documents over HTTP,
one request each, is neither fast nor deterministic) — the same exemption the
recipe above would otherwise require for a bulk operation.

- **Transaction shape.** Mirrors
  `apps/api/src/documents/document-markdown.service.ts`: `markdownToYjsState`
  produces the canonical Yjs state once, and every derived representation
  (ProseMirror JSON, plain text, re-serialized Markdown) is written alongside
  it. Markdown is never treated as canonical (rule 5, ADR-007); the enqueued
  `document-materialization` job re-derives everything from the Yjs state
  exactly as it would for any other document.
- **Identity without an import-id column.** The schema is frozen, so a
  document's identity for idempotency purposes is
  `(workspaceId, parentId, title)`. Every create goes through a find-first on
  that triple, which is what makes the script safely re-runnable — at the cost
  that renaming a note or folder in the vault and re-running creates a second
  page rather than moving the first one.
- **Wikilinks resolve by title**, exactly like Obsidian: a `[[Target]]` is
  looked up by filename (case-insensitively) against every other note in the
  vault, then rewritten to the _native_ `[[Titel]]` / `[[Titel|Label]]` wiki
  syntax carrying the resolved note's title — not the
  `[Label](wiki:Titel)` Markdown-link form, because `packages/editor`'s
  Markdown parser only allows a fixed built-in list of link protocols and
  rejects `wiki:` there; the double-bracket form is a dedicated parsing path
  that already emits a `wiki:` href and round-trips losslessly. Fenced code
  blocks and inline code spans are never rewritten. An unresolved target
  becomes plain text, never a broken link.
- **Known limitation.** The two frontmatter shapes the vault uses (bookmarks,
  recipes) are rendered as a leading callout so their content is visible on
  the page, but only the fields the callout renders
  (source/`quelle`, `saved_at`, `portionen`, `tags`) survive past the first
  materialization run — the rest of the frontmatter (`domain`, `folder`,
  `review_due`, `notiert`) is preserved in the imported Markdown only until
  materialization re-derives it purely from the Yjs state. Turning these 14
  notes into a `COLLECTION` with real properties would fix this; that is a
  bigger decision than an import script should make on its own.
- Batches the materialization enqueue (50 jobs, 100 ms pause) so an 8 GB host
  serving live traffic is not asked to process 600+ jobs at once, and prints a
  verification pass/fail report (`--verify-only`) covering document counts,
  wikilink resolution rate, spot-checked round trips and full-text search.

## Observability

- structured JSON logs via `packages/logger` (pino) with a redaction list that
  covers passwords, tokens, tickets, cookies and every document payload field
- a correlation id per request (`x-correlation-id`, propagated into jobs and log
  lines through `AsyncLocalStorage`)
- `GET /health/live` and `GET /health/ready`; readiness probes PostgreSQL, Redis and
  object storage and answers `503` when degraded
- distributed tracing over API, queue, worker and the AI tool loop
  (ADR-031): `packages/logger/src/tracing.ts` is the contract every call site
  uses, `packages/logger/src/otel.ts` the OpenTelemetry implementation
  `startTracing()` installs. Off, and not even loaded, until
  `OTEL_EXPORTER_OTLP_ENDPOINT` names a collector; the trace context travels to
  a job in its payload and to the API as a `traceparent` header, and every log
  line written under a span carries `traceId` and `spanId`. What is traced,
  what never is, and how to add a span: `docs/observability.md`
