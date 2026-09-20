# eXocortex Implementation Plan

> **Historical.** This is the plan for the original greenfield build, which
> finished on 2026-08-04, and it is kept as the record of how the foundation was
> laid and what was found while verifying it. It is **not** a list of what
> exists today: databases, semantic search, MCP, the agent memory, automations,
> rendering, projects, entities and overview pages all came afterwards and are
> not in it. For the current state read `README.md`; for how the pieces fit
> together, `docs/architecture.md`; for why, `docs/adr/`.

Status legend: `[ ]` open · `[~]` in progress · `[x]` done

Starting point: **empty repository** (`/var/www/exocortex`, no files, no git history).
No existing architecture had to be preserved, so the plan below is a greenfield build.

## Target runtime

| Concern         | Choice                                                         |
| --------------- | -------------------------------------------------------------- |
| Node            | 24.18.1 (active LTS), pinned via `.nvmrc`, `engines`, Corepack |
| Package manager | pnpm 11.20.0 via Corepack                                      |
| Build orchestr. | Turborepo 2.10                                                 |
| Language        | TypeScript 7.0.2, strict, no `any`                             |

## Phases

### Phase 1 — Repository and tooling `[x]`

- [x] pnpm workspace + Turborepo pipeline
- [x] `tsconfig.base.json` / `.node` / `.react` presets, strict mode
- [x] ESLint 9 flat config, Prettier, import sorting
- [x] Dependency boundaries: `scripts/dependency-graph.mjs` +
      `scripts/check-dependency-boundaries.mjs` (manifest level) and
      `no-restricted-imports` (source level)
- [x] `docker-compose.yml`: PostgreSQL 17 (pgvector), Redis 8, MinIO, Mailpit,
      named volumes, health checks
- [x] `.env.example` + runtime env validation in `@exocortex/config`
- [x] ADR-001 … ADR-010

### Phase 2 — UI foundation `[x]`

- [x] `packages/ui`: semantic theme tokens, shadcn/ui components on Base UI
      primitives, layout primitives, loading/empty/error states
- [x] `apps/web` application shell (three-pane, collapsible, resizable)
- [x] Authentication layouts

### Phase 3 — Database and authentication `[x]`

- [x] Prisma schema: users/sessions (Better Auth), Workspace, WorkspaceMember,
      Document, DocumentContent, DocumentSnapshot, Attachment, OutboxEvent,
      AuditLog, DocumentEmbedding (pgvector, unused)
- [x] Migration incl. `pg_trgm`, `vector`, tsvector column + GIN indexes
- [x] Better Auth (email/password, sessions, verification + reset infra, Mailpit)
- [x] Fractional `orderKey` for stable sibling ordering
- [x] Central authorization policies

### Phase 4 — Editor `[x]`

- [x] `packages/editor`: canonical schema, `ExocortexEditorExtension` contract
- [x] Stable block IDs (`blockId` attribute + Tiptap extension)
- [x] Custom `callout` node
- [x] Markdown parser/serializer, plain-text serializer, frontmatter, wiki links
- [x] Round-trip fixtures and tests

### Phase 5 — Collaboration `[x]`

- [x] `apps/collaboration` (Hocuspocus 4) with binary Yjs persistence
- [x] Signed, short-lived, per-document collaboration tickets
- [x] Read-only enforcement, archived documents rejected
- [x] Materialization job enqueued (debounced) on store
- [x] `y-indexeddb` offline persistence in the web client

### Phase 6 — Realtime and workers `[x]`

- [x] `packages/contracts`: zod schemas for REST DTOs and WebSocket events
- [x] NestJS Socket.IO gateway with server-side room authorization
- [x] Redis adapter boundary for horizontal scaling
- [x] `packages/queue` (BullMQ) + `apps/worker`: materialization, search
      indexing, ai and maintenance queues

### Phase 7 — Search, storage, AI `[x]`

- [x] PostgreSQL full-text search + trigram title search behind a
      `SearchAdapter` interface
- [x] `packages/storage` S3 abstraction, MinIO locally, magic-byte MIME sniffing
- [x] Attachment upload/download/delete with permission checks
- [x] `packages/ai`: provider contract, mock streaming provider, OpenRouter
      adapter skeleton, Claude Code / Codex runner interfaces
- [x] AI side panel streaming through the application WebSocket

### Phase 8 — Vertical slice and quality `[x]`

- [x] End-to-end UI flow
- [x] Seed data (Johanna, Stefan, shared workspace, nested pages)
- [x] Unit, integration, authorization, round-trip, idempotency tests
- [x] Playwright two-browser collaboration test
- [x] Documentation and ADRs

### Phase 9 — Deployment `[x]`

- [x] nginx vhost for `exocortex.app`, HTTP basic auth, Let's Encrypt TLS
- [x] systemd units for web / api / collaboration / worker
- [x] Production `.env`, build, migrate, seed

## Status

All phases complete. Verified on 2026-08-04:

| Command          | Result                                                       |
| ---------------- | ------------------------------------------------------------ |
| `pnpm build`     | 14 tasks successful                                          |
| `pnpm lint`      | dependency boundaries OK (14 packages) + 25 tasks successful |
| `pnpm typecheck` | 25 tasks successful                                          |
| `pnpm test`      | 25 tasks successful, 184 tests passed                        |
| `pnpm test:e2e`  | 28 tests passed against https://exocortex.app                |

## Bugs found and fixed during verification

These were real defects the test suite surfaced, not test problems:

1. **BullMQ rejects `:` in custom job ids.** The collaboration server's debounced
   materialization enqueue used `materialize:<documentId>`, so _every_ Yjs store
   hook threw and nothing was ever persisted. Fixed to `materialize-<documentId>`
   and `QueueRegistry.enqueueDebounced` now fails fast on a colon so the mistake
   cannot hide inside a persistence hook again.
2. **Sibling ordering used the database's default collation.** The fractional
   index assumes byte order, but `en_US.UTF-8` sorts `l` before `V`, so sibling
   order depended on the server locale. Migration
   `20260804101500_order_key_c_collation` pins the column to the `C` collation.
3. **Two ProseMirror instances in the browser bundle.** `@exocortex/editor` was
   consumed as CommonJS inside an ESM bundle, which made ProseMirror reject
   plugins ("Adding different instances of a keyed plugin") and broke the editor
   completely. The package now exposes its TypeScript source through the `import`
   condition and is listed in `transpilePackages`.
4. **`Button` swallowed `type="submit"`.** Base UI lets the render element's own
   props win, so the default `<button type="button">` overrode the caller's
   `type` and no form could be submitted. The type is now part of the merged
   props with an explicit default.
5. **`PUBLIC_*` values were not baked into the production bundle.** Next.js only
   reads env files from its own directory, so the browser tried to reach
   `localhost:3211`. `apps/web/.env` is now a symlink to the root `.env`.
6. **`consistent-type-imports` broke NestJS dependency injection.** The ESLint
   autofix rewrote injected classes to type-only imports, which erases the
   runtime metadata Nest needs. The rule is now disabled for `apps/api` with an
   explanation.
7. **Archive/restore did not refresh the open document.** The mutations only
   invalidated the tree query, so the archived banner did not appear or
   disappear. Both now invalidate the document detail query as well.

## Deviations from the original brief

See `docs/deviations.md`.
