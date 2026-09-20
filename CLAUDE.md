# CLAUDE.md — instructions for Claude Code sessions in this repository

eXocortex is a self-hostable, collaborative workspace and external brain. This
file is the contract for automated sessions. Read it before changing code.

## Non-negotiable rules

1. **Use the shadcn skill and the shadcn MCP server for UI work.**
   The MCP server is configured in `.mcp.json` (it runs with `-c packages/ui`, so
   it reads `packages/ui/components.json`). Before writing any component:
   - search the configured registries through MCP
     (`list_items_in_registries`, `search_items_in_registries`)
   - read the current source and docs (`view_items_in_registries`,
     `get_item_examples_from_registries`, `shadcn docs <component>`)
   - install with the official CLI: `cd packages/ui && pnpm dlx shadcn@4.16.1 add <name>`
   - only then adapt the installed source to the eXocortex design system
2. **Search existing components before creating new ones.**
   `packages/ui/src/components/ui` and `packages/ui/src/components` first,
   the shadcn registry second, a new primitive last.
3. **Never introduce a second UI framework.** No Material UI, Chakra, Ant Design,
   Mantine or Bootstrap. Primitives come from `@base-ui/react`.
   The public shadcn registry ships Radix-based sources; adapt them to Base UI
   (see `packages/ui/src/components/ui/button.tsx` for the pattern) and remove the
   `radix-ui` dependency again.
4. **Never bypass the package boundaries.** They are enforced twice:
   `scripts/dependency-graph.mjs` (checked by `scripts/check-dependency-boundaries.mjs`
   during `pnpm lint`) and `no-restricted-imports` in `eslint.config.mjs`.
   In particular `apps/web` must never import `@exocortex/database`,
   `@exocortex/queue`, `@exocortex/storage`, `@exocortex/ai` or `@exocortex/logger`.
5. **Markdown is never the canonical collaborative state.** The canonical state is
   the binary Yjs update stored in `DocumentContent.yjsState`. ProseMirror JSON,
   plain text and Markdown are derived by the materialization job and may be
   rebuilt at any time. Never write a feature that edits Markdown and treats it as
   the truth.
6. **Never execute CLI agents inside the API, the Next.js server or the
   collaboration server.** Claude Code and Codex runners must run in an isolated
   worker or container (`packages/ai/src/agent-runners.ts`, `apps/worker`).
7. **No `any`.** If an external library forces it, isolate it behind a typed
   wrapper and document why (see `packages/editor/src/yjs.ts`).
8. **Visible UI text is German. Code, comments, logs, identifiers and API error
   codes are English.**
9. **No hardcoded colours.** Use the semantic tokens from
   `packages/ui/src/tokens.css` through Tailwind utilities. The single exception
   is the brand amber in `packages/ui/src/components/logo.tsx`: a logo keeps its
   colour when the surface underneath it changes.
10. **The brand is written `eXocortex`** — small `e`, capital `X` — in every
    string a human reads: UI text, page titles, email subjects, documentation,
    headings, and at the start of a sentence. Technical identifiers keep the
    plain lowercase form and must never be renamed in a search-and-replace:
    the `@exocortex/*` package names, the `exocortex-*` CSS class prefix, the
    `exocortex` cookie prefix, `exocortex.ai.*` local-storage keys, the
    `exocortex:*` NestJS metadata keys, `EXOCORTEX_*` environment variables,
    `data-testid` values, the domain, the systemd units and the database name.
11. **Every feature change must be reflected in the MCP surface.**
    `packages/mcp-tools` is the single tool catalogue: it serves both the external
    stdio MCP server (`apps/mcp`) and the built-in AI's tool loop in
    `apps/worker`. If a change adds, alters or removes something a human can do
    in the application, the same capability must be added, altered or removed in
    the catalogue in the same commit series — with a REST endpoint behind it,
    because the catalogue only ever calls the API. A pull request that extends the
    UI without extending the catalogue is incomplete. Recipe: `docs/mcp.md`.
12. **The browser, the built-in AI and MCP reach the same capabilities.**
    ADR-025: if the product can do it, all three can do it. A tool goes on both
    agent surfaces (`surfaces: ['mcp', 'ai']`) unless there is a reason in
    `SURFACE_EXEMPT` in `scripts/check-capability-parity.mjs`, and a route the
    browser calls that no tool reaches needs a reason in `EXEMPT` in
    `scripts/check-mcp-catalog.mjs`. Parity is semantic: a drag is not a
    feature, `move` is. Read-side parity counts too — status, errors and
    results have to be machine-readable, and an asynchronous feature offers the
    whole loop (start, status, diagnostics, result, retry, cancel).
    Regenerate `docs/capability-matrix.md` with
    `node scripts/check-capability-parity.mjs --write` in the same commit
    series.
13. **Documentation moves with the code, in the same commit series.**
    The central documents are what the next session believes about this system
    before it reads a line of code, so a stale one produces wrong work rather
    than a cosmetic blemish (issue #58). `AGENTS.md` carries the table of what
    to update when, and `scripts/check-docs-current.mjs` is the hard gate under
    it: it reads the packages, queues, maintenance tasks, compose services and
    systemd units out of the source and fails the build when a document stops
    naming one, plus a list of claims paired with the file that disproves them.
    Two habits the gate cannot enforce: the README's "What works today" and
    "Not built" sections describe today, and a sentence calling something
    planned or deferred is a claim that has to be deleted the day it stops
    being true.
14. **The licence is PolyForm Noncommercial 1.0.0, and the project is called
    source available, never open source.** A restriction on the field of use is
    exactly what that term excludes, so the wrong word in a README or a landing
    page is a false statement about what a reader is allowed to do. Two things
    follow for code: no dependency under GPL or AGPL may enter `apps/` or
    `packages/`, because a copyleft licence would force the combined work to be
    something this licence cannot be; and contributions carry the grant in
    `CONTRIBUTING.md`, which is what keeps relicensing possible at all.
    Individual exceptions live in `LICENSE-GRANTS.md`, never in `LICENSE`.
15. **A capability a person cannot discover is a capability nobody has.**
    `packages/features` is the registry of what this deployment can do, written
    in the words somebody would use to ask for it, and it is what `/hilfe` and
    `exo_features` serve. Every MCP tool, every screen in `apps/web` and every
    automation trigger has to be claimed by an entry, or
    `scripts/check-feature-coverage.mjs` goes red; a claim that no longer
    matches anything goes red too. So a feature change adds or amends an entry
    in the same commit series, and `since` is the day it goes live, because
    that date is what tells every reader it is new to them (ADR-040). The gate
    counts, it cannot read: an entry that is complete and wrong passes, which
    is why the summary is written for the person and not for the counter.

## Repository map

| Path                                  | Responsibility                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                            | Next.js frontend (App Router). No direct database, Redis or storage access.                                                                                                                              |
| `apps/api`                            | NestJS + Fastify REST API, Better Auth handler, Socket.IO gateway. Owns business logic.                                                                                                                  |
| `apps/collaboration`                  | Hocuspocus server, binary Yjs persistence, ticket verification.                                                                                                                                          |
| `apps/worker`                         | BullMQ worker: materialization, search indexing, AI runs, maintenance.                                                                                                                                   |
| `apps/mcp`                            | stdio JSON-RPC MCP server for external clients (Hermes, Claude Code).                                                                                                                                    |
| `packages/mcp-tools`                  | The one tool catalogue: shared by `apps/mcp` and the worker's AI tool loop.                                                                                                                              |
| `packages/config`                     | Runtime-validated environment schemas.                                                                                                                                                                   |
| `packages/contracts`                  | zod schemas for REST DTOs, WebSocket events, job payloads.                                                                                                                                               |
| `packages/database`                   | Prisma schema, migrations, order keys, tree helpers, full-text and hybrid search adapters.                                                                                                               |
| `packages/auth`                       | Better Auth setup, session verification, authorization policies, collaboration tickets.                                                                                                                  |
| `packages/features`                   | The feature registry: one hand-written entry per capability, in the words a person would use. Data only, typed against the wire contract.                                                                |
| `packages/editor`                     | Canonical Tiptap schema, block IDs, block catalog, Markdown, Yjs materialization.                                                                                                                        |
| `packages/queue`                      | Typed BullMQ queues, workers, Redis event bus.                                                                                                                                                           |
| `packages/storage`                    | S3-compatible object storage, MIME sniffing, image downscaling.                                                                                                                                          |
| `packages/ai`                         | Provider-neutral AI contracts, OpenRouter, embeddings, mock provider, runner contracts.                                                                                                                  |
| `packages/calendar`                   | iCalendar parsing and serialization, recurrence expansion, reminder scheduling.                                                                                                                          |
| `packages/logger`                     | Structured logging, correlation ids, the redaction list, the tracer and its OpenTelemetry implementation.                                                                                                |
| `packages/ui`                         | Design tokens, shadcn components on Base UI, layout primitives, states.                                                                                                                                  |
| `e2e`                                 | Playwright browser and API tests.                                                                                                                                                                        |
| `integrations/hermes-memory-provider` | The Hermes memory provider: a small Python package that checkpoints a conversation into this deployment before Hermes compacts it away. Standard library only, and it fails closed.                      |
| `tools/claude-code-plugin`            | The Claude Code plugin: the MCP server over HTTP, the SessionStart/SessionEnd hooks that make this deployment Claude Code's memory, and the setup skill. Plain Node, no dependencies, silent on failure. |

## Commands

```bash
pnpm install
pnpm infra:up          # PostgreSQL, Redis, MinIO, Mailpit
pnpm db:migrate
pnpm db:seed           # prints one-time credentials
pnpm dev
```

Before handing work over, and before rolling anything out, there is one entry
point rather than four:

```bash
bash scripts/build.sh  # working tree, hard gates, sequential build, lint,
                       # format, typecheck, gate tests, tests. Starts no service.
bash scripts/deploy.sh # build.sh, then migrations, nginx, the four units,
                       # readiness, and the deploy marker last.
```

`build.sh` is the one to reach for: it runs the ten hard gates that have no
bypass (package boundaries, `.env.example` sync, brand spelling, MCP catalogue
completeness, capability parity, feature registry coverage, documentation
currency, the unit/integration test split, typecheck coverage, migration
reproducibility) as well as the checks below, in the right order and without
racing the live units for memory. `deploy/README.md` explains what each step does.

The same script is the whole of `.github/workflows/build.yml`: the CI installs
Node, pnpm and nothing else, then runs `bash scripts/build.sh`. A check that has
to happen in CI belongs in that script, never in the workflow file, otherwise
there are two rulebooks and the deployment host follows the older one.

The individual commands still exist and are useful while iterating:

```bash
pnpm build
pnpm lint              # dependency boundaries + ESLint, src/ of each package only
pnpm exec eslint .     # the whole repository, including scripts/ and e2e/
pnpm format            # Prettier over the tree; format:check is what build.sh runs
pnpm typecheck
pnpm test:unit         # every test that needs no infrastructure, in every
                       # workspace -- this is what build.sh and CI run
pnpm test:integration  # only `*.integration.test.ts` -- brings up its own
                       # throwaway Postgres and Redis, and can reach no other
pnpm test              # both halves at once
pnpm test:gates        # proves each gate can still go red
pnpm test:e2e          # Playwright (needs a running deployment)
```

A test belongs to one half or the other by its file name, and the test-split
gate enforces it: `*.integration.test.ts` may open a database, Redis or storage
connection, and nothing else may. Adding a test that needs infrastructure means
naming it that way; adding a workspace with tests means giving it the two
scripts, or `turbo run test:unit` walks past it and its tests run nowhere.

## Architectural decisions you must not silently reverse

- ADR-004/005: one Yjs document per eXocortex document; the binary state is
  canonical and is never rebuilt from JSON on load.
- ADR-007: Markdown is an interchange format only.
- ADR-008: application events and Yjs updates travel over **separate** sockets.
- ADR-010: domain events that need reliable follow-up work go through the
  transactional outbox, not through fire-and-forget calls.
- ADR-011: a database is a `Document` with `type: 'COLLECTION'`; its rows are
  ordinary `Document`s (`type: 'PAGE'`) underneath it, not a separate model.
- ADR-013: runtime configuration lives in the `setting` table; the environment is
  the bootstrap fallback, never the runtime authority.
- ADR-014: one tool catalogue (`packages/mcp-tools`) serves external MCP clients
  and the built-in AI, and it reaches the domain only through the REST API.
- ADR-016: a write that does not come from the editor must reach the open
  editing session through the collaboration server, never only the database.
- ADR-018: MCP is served over two transports (stdio bin and `POST /api/mcp`)
  that share one protocol dispatcher; the HTTP one reaches the domain by calling
  the REST API over loopback, never Prisma, and it accepts bearer credentials
  only, never a cookie.
- ADR-019: agent memory is its own workspace (`Workspace.isMemory`, ADR-023), written
  through the ordinary domain services; a raw transcript is never stored, and
  authority comes from the agent account's membership, not from its token scope.
- ADR-020: semantic search sits beside full-text and never replaces it.
  `HybridSearchAdapter` wraps `PostgresSearchAdapter`, fuses the two lists by
  rank, and falls back to full-text alone whenever the embedding call fails.
  `packages/database` reaches the model through a port, never by importing
  `@exocortex/ai`.
- ADR-021: the memory keeps distilled facts above its session notes. A fact is
  an ordinary page plus a `MemoryFact` sidecar row; a nightly job judges notes
  against it and the API applies the judgement; confidence fades with silence
  instead of notes expiring by age; a contradiction is marked, never resolved by
  weight; promotion into a curated workspace stays a human act.
- ADR-022: an agent's writes are grouped by a session id announced at
  `initialize` and carried in a header; the journal is written from the outbox
  and points at the snapshot before each write, never at content. A bulk revert
  is a series of ordinary snapshot restores, partial by nature, and it names
  every page it skipped. Listing a session is a tool; reverting one is
  deliberately not.
- ADR-023: a setting carries a scope. `SETTING_SCOPES` splits the keys into
  deployment-wide and workspace-overridable; `workspace_setting` is a fourth
  resolution layer where an absent row means inherit; `SETTING_CEILINGS` clamps
  while resolving so lowering a deployment value pulls every workspace down.
  The agent memory is `Workspace.isMemory` on the row, not a settings key, and
  credentials never become settings.
- ADR-024: automations react to changes through the outbox and nowhere else
  (the clock is the other half, ADR-038); a rule
  never fires on its own action and a chain stops at depth three; an AI rule
  writes a comment or a child page and never overwrites content; the webhook
  allowlist and `automations.enabled` both default to refusing.
- ADR-025: the browser, the built-in AI and MCP are three clients of one API
  and reach the same capabilities. The exceptions are two lists with written
  reasons, both of which go red when an entry stops matching;
  `docs/capability-matrix.md` is generated from the source, never authored.
- ADR-026: a rendered file is a derived view, never a second canonical state.
  Markdown goes through Pandoc into a Pandoc template and xelatex inside a
  container fed by a pipe (no bind mounts, no network); the artifact is an
  ordinary `Attachment`, so it is downloadable, deletable and text-extractable
  like any other file -- which is how an agent inspects a visual result. The
  input hash is both the build cache and the staleness comparison.
- ADR-027: a project is a `Document` with `type: PROJECT` whose Yjs state holds
  a file tree, not prose; `ProjectFile` rows are the derived projection and a
  write reaches the tree through the collaboration server, never the rows. The
  compiler is `latexmk` in a container, on the server, because there is no
  permissively licensed in-browser TeX -- no AGPL package may enter this
  repository or its bundle. Since 2026-09-16 that ban has a second, stronger
  reason: the project's own licence (rule 14) cannot coexist with copyleft.
- ADR-028: an overview page's text is derived, never its body. A digest per
  page and a composition per overview live in `DocumentDigest`, the composition
  is built from the children's digests rather than their content, and two input
  hashes decide whether a refresh costs anything. Triggered from the outbox,
  swept hourly, and degraded to a plain child list whenever no model can be
  reached.
- ADR-029: withdrawing access reaches connections that are already open. A
  revocation travels on its own Redis channel, never on the application event
  bus and never through the outbox; a revoked connection is replaced rather than
  patched, so a widened permission only ever arrives through a fresh handshake;
  and a periodic re-authorization sweep in both the gateway and the
  collaboration server is what the guarantee rests on when a message is missed.
- ADR-030: the built-in AI's right to change anything depends on what it has
  read. Foreign text (an extracted document, a described image, later the web)
  is fenced as data before it enters the context and marks the run; a mutating
  tool call is then refused by one decision in `tool-runner.ts` rather than by a
  check per tool. The policy is a setting a workspace can only tighten, never a
  request parameter: a boundary a run can raise for itself is one an injected
  paragraph can raise for itself.
- ADR-031: tracing is optional and the trace travels in band. The tracer is our
  own interface with a no-op default (`packages/logger/src/tracing.ts`);
  `otel.ts` is the only file that imports `@opentelemetry/*` and loads the SDK
  lazily, so a deployment without a collector is unchanged. A job carries its
  parent as `traceparent` in the payload, the worker's tool calls carry it as a
  header, and a span holds ids, durations and outcomes -- never content.
- ADR-032: a request goes only to the providers that can serve it. The registry
  keeps one row per provider per model (`AiModelEndpoint`), the model's window
  is the largest of them, and eligibility is re-planned before every turn and
  handed to OpenRouter as `provider.only` plus `allow_fallbacks` -- never a
  `sort` or an order, because ranking inside the eligible set stays the
  provider's job. Compaction answers "can anyone still serve this", and only
  runs when a smaller prompt would change the answer.
- ADR-033: web research is two REST calls, never an MCP client in the worker.
  Search (SearXNG) and fetching (Steel) are separate tools because the choice
  between them is what research costs; the address check in
  `apps/api/src/research/public-address.ts` judges the _resolved_ address before
  the browser sees it and again after a redirect, because the browser fetches
  from inside this host's Docker network; the per-run fetch budget is counted in
  the worker, since only the loop knows what a run is.
- ADR-034: a page above 2400 characters is also embedded as passages of about
  2000 characters, stored under `blockId = 'chunk:NNNN'` with the passage text
  beside the vector. They are added _beside_ the whole-document row, never
  instead of it, because `findRelated` asks about pages; a search folds the
  nearest rows to one per page before fusion, and the winning passage becomes
  the excerpt.
- ADR-035: an MCP subscription is delivered on a channel each transport opens
  for itself (stdio consumes `GET /api/mcp/changes`, Streamable HTTP opens the
  SSE stream on `GET /api/mcp`), and `packages/mcp-tools` holds the
  subscription set without holding a socket. Every notification is authorized
  against the database at the moment it is written, not when the stream opened,
  so a withdrawn membership cannot deliver one; a revocation closes the stream
  rather than trimming it, and a subscription to a page that does not exist
  succeeds, because refusing it would answer what `resources/read` refuses to
  answer.
- ADR-036: a capture is an ordinary page created by the ordinary services, and
  the inbox it lands in is a page carrying `Document.isInbox`, not a setting and
  not a title lookup. The flag is kept unique per workspace by a hand-written
  partial index,
  the page is created by the first capture that needs it, and filing is the
  existing `suggest-parent` plus `move` rather than a route of its own.
- ADR-037: a clip is a capture with a provenance line, not a second content
  type; reading the page itself is opt-in and goes through the address check of
  ADR-033; the share target and the bookmarklet share one GET route, because the
  service worker answers nothing; and `exo_clip` carries the web fence although
  it returns no web text, so a run cannot clip a page and read it back around
  the fence on `exo_web_fetch`.
- ADR-038: a schedule is a trigger on the existing rule, not a second entity.
  `SCHEDULE` is exclusive and a scheduled rule names its page, because the clock
  names none; `nextRunAt` is a column computed by one pure function both the API
  and the worker call, never a repeatable job in Redis; the minute sweep claims a
  rule by filtering on the `nextRunAt` it read, moves it on before queueing it,
  and catches up once rather than for every slot a stopped deployment slept
  through. A run carries `origin` beside its trigger.
- ADR-039: a template is an ordinary page carrying a `DocumentTemplate`
  sidecar, and using one is a copy that keeps nothing: no link back, no
  propagation. The copy is built from the canonical Yjs state rather than from
  Markdown, block ids are regenerated while every reference outwards is kept,
  row properties travel only within one database, and `renderTitlePattern` is
  the one function both the API and the browser build the new title with.
- ADR-040: the feature registry is written by hand and counted by a gate. What
  a person can do here is a German sentence in `packages/features`, not a route
  in the matrix or a tool description; three inventories (tools, screens,
  automation triggers) have to be claimed by an entry or the build goes red,
  and a claim that matches nothing goes red too. Discovery is a per-person
  date, and an absent marker means the reader has missed nothing.
- ADR-041: a computed database column is a SQL expression, never a stored
  value. A RELATION is a list of row ids in the `jsonValue` column the
  array-valued types already use; a ROLLUP and a FORMULA store nothing and are
  compiled on every read, so the same expression serves the SELECT, the WHERE
  and the ORDER BY -- which is the only way a computed column can be filtered
  and sorted. The formula language is our own, total and typed
  (`packages/contracts/src/database-formula.ts`); a rollup never aggregates
  over another derived column, which bounds the schema a read has to load to
  one hop; a relation may not cross a workspace; and a configuration that
  stops compiling is refused when it is written, except for a rename, which
  rewrites the formulas that name the column.
- ADR-042: a saved query stores the question and never an answer. A saved
  search, a smart view and a query block are one `SavedQuery` row with
  different flags on it; the query runs as the caller on every read, so
  permissions are never frozen at save time and no job keeps a result list
  warm. The words are answered by the search adapter and everything else by one
  SQL predicate over `document`, in that order, because the adapter takes no
  list of allowed ids. A relative window and a subtree are resolved while the
  query runs, which is what makes a stored question keep moving.
- ADR-043: a pinned source is a reference with a budget. A conversation may
  carry pages, database views and saved searches beside the page it stands on;
  each is merely named by default and embedded only on a second, deliberate
  choice, and everything embedded shares one character budget split into equal
  shares. One renderer in `packages/database` serves both the chip row's size
  and the prompt's text, so the promise above the composer is about the same
  characters. Pinning stays the person's: `exo_chat_context` reads the list,
  and no tool writes it.
- ADR-044: a grant is a row on a page, and a confinement travels with the
  credential. A share is expressed as a `WorkspaceRole` so every existing policy
  applies unchanged; `SUBTREE` is resolved against the hierarchy on every
  request, never against a stored list of ids. A public link is read-only by a
  check constraint and served by its own tiny anonymous surface, because a
  principal without a user id cannot go through `WorkspaceAccessService`. Page
  scopes on a token are read by `SessionGuard` into the request context and
  consulted only there: `findRole` and `requireRole` fail closed for a confined
  credential, and the readers that can narrow opt in through
  `requireScopedRole`, `requireRoleAnchoredAt` and `visibleDocumentIds`.
- ADR-045: a transclusion stores a reference and no content, so the same
  paragraph is indexed once however many pages show it. A heading addresses its
  whole section; the fragment is read at read time through one route that runs
  as the reader, so the source's permissions apply where it is shown; and it
  expands exactly one level, in the browser, the export and the tool alike,
  which makes a cycle impossible instead of detectable. A dead block is stated,
  never repaired with the nearest surviving one, and Markdown addresses the
  source by title like every other reference.
- ADR-046: a checkpoint is a receipt, not an archive.
  `POST /api/memory/checkpoint` is the one memory call that waits and that
  throws: an agent about to compact its own conversation away may only do so
  once a note is committed, so a soft refusal would become permission to
  forget. What is stored is digests and counts, never message text, and
  deduplication is per message rather than per payload, because a client sends
  longer prefixes rather than retries.
- ADR-047: a message between agents is a delivery, not a page. `AgentMessage`
  is a row, because a message shaped like a page would be swept into the fact
  layer by the nightly consolidation and would age on the notes' clock instead
  of its own; addressing is membership of one memory area, so the permission
  question was answered before the feature existed; reading never
  acknowledges, because a session that dies on its first call must not have
  lost its post; and the rendered block reserves its fence before it writes a
  word, so a budget that runs out drops messages and never the sentence saying
  this is data.
- ADR-048: a push subscription is a device, and the worker holds the key. The
  kinds a browser accepts are a column on the subscription rather than a
  setting on the person, because a phone in a pocket and a desktop at work
  want different things; the VAPID pair lives in the worker's environment and
  never in the `setting` table, so the process answering the public internet
  holds no signing key; a job names a person, so which devices hear it is read
  at send time; and a push service answering 404 or 410 deletes the row,
  because a subscription it has forgotten can never come back.
- ADR-015: the open page's _text_ reaches the prompt only when
  `ai.pageContextEnabled` is switched on, and that setting defaults to off. The
  page's title and path always do; a selection the user hands over always does.

Full list: `docs/adr/`.

## How to extend the system

Each of these has a step-by-step recipe:

| Task                                                     | Document                    |
| -------------------------------------------------------- | --------------------------- |
| new shadcn component, custom primitive                   | `docs/ui-system.md`         |
| new editor node, block catalog entry, document migration | `docs/editor-extensions.md` |
| new WebSocket event                                      | `docs/architecture.md`      |
| new background job                                       | `docs/background-jobs.md`   |
| new AI provider, agent runner                            | `docs/ai-architecture.md`   |
| new storage backend                                      | `docs/architecture.md`      |
| new database property type, view type                    | `docs/database-views.md`    |
| new MCP tool, new AI tool                                | `docs/mcp.md`               |
| new admin setting, admin page                            | `docs/admin.md`             |
| new automation trigger or action                         | `docs/automations.md`       |
| new render template, new renderer                        | `docs/render.md`            |
| new project type, project build runner                   | `docs/projects.md`          |
| overview pages, digests, composition prompts             | `docs/overview-pages.md`    |
| new page template placeholder, template UI               | `docs/templates.md`         |
| new feature entry, the help page, the coverage gate      | `docs/features.md`          |
| new saved-query dimension, smart views, query blocks     | `docs/saved-queries.md`     |
| new kind of share, a route that answers with pages       | `docs/sharing.md`           |

## Deployment on this machine

`exocortex.app` is served by nginx with TLS and HTTP basic auth in front of four
systemd units (`exocortex-web`, `exocortex-api`, `exocortex-collaboration`,
`exocortex-worker`). See `deploy/README.md`.
