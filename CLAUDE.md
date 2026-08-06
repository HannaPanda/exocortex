# CLAUDE.md — instructions for Claude Code sessions in this repository

Exocortex is a self-hostable, collaborative workspace and external brain. This
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
   - only then adapt the installed source to the Exocortex design system
2. **Search existing components before creating new ones.**
   `packages/ui/src/components/ui` and `packages/ui/src/components` first,
   the shadcn registry second, a new primitive last.
3. **Never introduce a second UI framework.** No Material UI, Chakra, Ant Design,
   Mantine or Bootstrap. Primitives come from `@base-ui-components/react`.
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
   `packages/ui/src/tokens.css` through Tailwind utilities.
10. **Every feature change must be reflected in the MCP surface.**
    `packages/mcp-tools` is the single tool catalogue: it serves both the external
    stdio MCP server (`apps/mcp`) and the built-in AI's tool loop in
    `apps/worker`. If a change adds, alters or removes something a human can do
    in the application, the same capability must be added, altered or removed in
    the catalogue in the same commit series — with a REST endpoint behind it,
    because the catalogue only ever calls the API. A pull request that extends the
    UI without extending the catalogue is incomplete. Recipe: `docs/mcp.md`.

## Repository map

| Path                    | Responsibility |
| ----------------------- | -------------- |
| `apps/web`              | Next.js frontend (App Router). No direct database, Redis or storage access. |
| `apps/api`              | NestJS + Fastify REST API, Better Auth handler, Socket.IO gateway. Owns business logic. |
| `apps/collaboration`    | Hocuspocus server, binary Yjs persistence, ticket verification. |
| `apps/worker`           | BullMQ worker: materialization, search indexing, AI runs, maintenance. |
| `apps/mcp`              | stdio JSON-RPC MCP server for external clients (Hermes, Claude Code). |
| `packages/mcp-tools`    | The one tool catalogue: shared by `apps/mcp` and the worker's AI tool loop. |
| `packages/config`       | Runtime-validated environment schemas. |
| `packages/contracts`    | zod schemas for REST DTOs, WebSocket events, job payloads. |
| `packages/database`     | Prisma schema, migrations, order keys, tree helpers, search adapter. |
| `packages/auth`         | Better Auth setup, session verification, authorization policies, collaboration tickets. |
| `packages/editor`       | Canonical Tiptap schema, block IDs, block catalog, Markdown, Yjs materialization. |
| `packages/queue`        | Typed BullMQ queues, workers, Redis event bus. |
| `packages/storage`      | S3-compatible object storage, MIME sniffing. |
| `packages/ai`           | Provider-neutral AI contracts, mock provider, runner contracts. |
| `packages/ui`           | Design tokens, shadcn components on Base UI, layout primitives, states. |
| `e2e`                   | Playwright browser and API tests. |

## Commands

```bash
pnpm install
pnpm infra:up          # PostgreSQL, Redis, MinIO, Mailpit
pnpm db:migrate
pnpm db:seed           # prints one-time credentials
pnpm dev
pnpm build
pnpm lint              # dependency boundaries + ESLint
pnpm typecheck
pnpm test              # unit and integration tests
pnpm test:e2e          # Playwright (needs a running deployment)
```

## Architectural decisions you must not silently reverse

* ADR-004/005: one Yjs document per Exocortex document; the binary state is
  canonical and is never rebuilt from JSON on load.
* ADR-007: Markdown is an interchange format only.
* ADR-008: application events and Yjs updates travel over **separate** sockets.
* ADR-010: domain events that need reliable follow-up work go through the
  transactional outbox, not through fire-and-forget calls.
* ADR-011: a database is a `Document` with `type: 'COLLECTION'`; its rows are
  ordinary `Document`s (`type: 'PAGE'`) underneath it, not a separate model.
* ADR-013: runtime configuration lives in the `setting` table; the environment is
  the bootstrap fallback, never the runtime authority.
* ADR-014: one tool catalogue (`packages/mcp-tools`) serves external MCP clients
  and the built-in AI, and it reaches the domain only through the REST API.
* ADR-016: a write that does not come from the editor must reach the open
  editing session through the collaboration server, never only the database.
* ADR-015: the open page's *text* reaches the prompt only when
  `ai.pageContextEnabled` is switched on, and that setting defaults to off. The
  page's title and path always do; a selection the user hands over always does.

Full list: `docs/adr/`.

## How to extend the system

Each of these has a step-by-step recipe:

| Task | Document |
| ---- | -------- |
| new shadcn component, custom primitive | `docs/ui-system.md` |
| new editor node, block catalog entry, document migration | `docs/editor-extensions.md` |
| new WebSocket event | `docs/architecture.md` |
| new background job | `docs/background-jobs.md` |
| new AI provider, agent runner | `docs/ai-architecture.md` |
| new storage backend | `docs/architecture.md` |
| new database property type, view type | `docs/database-views.md` |
| new MCP tool, new AI tool | `docs/mcp.md` |
| new admin setting, admin page | `docs/admin.md` |

## Deployment on this machine

`exocortex.app` is served by nginx with TLS and HTTP basic auth in front of four
systemd units (`exocortex-web`, `exocortex-api`, `exocortex-collaboration`,
`exocortex-worker`). See `deploy/README.md`.
