# Architecture

## Processes

```text
                     ┌──────────────────────────────┐
   browser  ─────────┤ nginx (TLS, HTTP basic auth) │
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

Four Node processes, deliberately separate:

* **web** renders the UI. It never touches PostgreSQL, Redis, object storage or any
  secret. Everything goes through the API on the same origin.
* **api** owns business logic, authentication, authorization and the application
  realtime channel.
* **collaboration** serves only the Yjs protocol. A crash in the editing hot path
  cannot take the REST API down, and it can be scaled independently.
* **worker** performs everything expensive: materialization, search indexing, AI
  runs, maintenance. No request handler ever does this work inline.

## Request and data flow of an edit

1. The browser asks the API for a collaboration ticket
   (`POST /api/documents/:id/collaboration-ticket`). The API resolves the caller's
   workspace role, derives the access mode from the policy layer and returns a
   signed, short-lived, single-document ticket.
2. The browser connects to the collaboration server with that ticket. The server
   verifies the signature, the expiry and the document scope, then **re-checks**
   workspace membership and archival state and takes the *minimum* of the ticket
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

| Channel | Path | Transport | Payload |
| ------- | ---- | --------- | ------- |
| collaboration | `/collab` | Hocuspocus/Yjs | document updates and awareness |
| application | `/realtime` | Socket.IO | domain events, job progress, AI streaming |

Awareness is never persisted. Domain events never travel over the Yjs protocol
(ADR-008).

## Reliability: outbox plus best-effort realtime

Domain mutations write an `OutboxEvent` row **inside the same transaction** as the
state change. The `dispatch-outbox` maintenance job turns those rows into follow-up
work (currently search indexing) and marks them processed; a failure records
`attempts` and `lastError` and is retried, never dropped.

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

* `parentId` gives arbitrary nesting.
* `orderKey` is a base62 fractional index. Inserting between two siblings generates
  a key strictly between theirs and touches no other row
  (`packages/database/src/order-key.ts`, 11 tests including 500 sequential and 200
  same-position insertions).
* Cross-workspace parents are rejected (`document_cross_workspace`).
* Circular moves are rejected (`document_move_cycle`), checked over the whole
  subtree inside the move transaction.
* Archiving a page archives its subtree, so no editable page can hang under an
  archived parent.
* Moves, archives, restores, snapshot restores, attachment deletions and permission
  changes write an `AuditLog` entry. Audit metadata never contains document content.

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

* a generated, weighted `tsvector` (title weight A, body weight B) with a GIN index,
* trigram similarity on the title for typo tolerance,
* `ts_headline` for highlighted snippets,
* a hard workspace filter in SQL.

Adding OpenSearch means adding a second implementation. The `vector` extension and
the `DocumentEmbedding` table already exist for a future semantic adapter; no
embeddings are generated yet.

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
send a `workspaceId` and every subscription is authorized.

### A new storage backend

Implement `ObjectStorage` (`packages/storage/src/object-storage.ts`) and provide it
in `apps/api/src/platform/platform.module.ts`. Object keys must stay
server-derived (`buildAttachmentKey`); clients never choose keys.

### A new REST endpoint

1. define request and response schemas in `packages/contracts`,
2. add a method to the relevant service, including the policy assertion,
3. add a thin controller method with `zodPipe(schema)` and
   `openApiSchema(schema)` so validation and OpenAPI come from the same source.

## Observability

* structured JSON logs via `packages/logger` (pino) with a redaction list that
  covers passwords, tokens, tickets, cookies and every document payload field
* a correlation id per request (`x-correlation-id`, propagated into jobs and log
  lines through `AsyncLocalStorage`)
* `GET /health/live` and `GET /health/ready`; readiness probes PostgreSQL, Redis and
  object storage and answers `503` when degraded
* an OpenTelemetry-compatible `Tracer` abstraction (`packages/logger/src/tracing.ts`)
  with a no-op default; a real SDK can be installed with `setTracer()`
