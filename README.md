# eXocortex

eXocortex is a self-hostable, collaborative workspace and external brain:
hierarchical pages, real-time collaborative editing, hybrid full-text and
semantic search, Notion-style databases, Markdown interchange, background
automation, LaTeX projects, PDF publishing and an AI side panel — all in one
deployment you control.

Three clients reach the same API and the same capabilities: the browser, the
built-in AI and an external MCP client (ADR-025). What a person can do in the
UI, an agent can do over MCP, and `docs/capability-matrix.md` is generated from
the source to prove it.

What is deliberately still missing is listed under
[Not built](#not-built).

## What works today

**Workspace and pages**

- email/password accounts, sessions, verification and password-reset mail;
  registration is invitation-only
- multiple workspaces with `OWNER` / `ADMIN` / `MEMBER` / `GUEST` roles; adding
  and removing members takes effect in open browser tabs, not only on the next
  request (ADR-029)
- arbitrarily nested pages with stable fractional ordering, trash, permanent
  deletion, page icons and cover images
- real-time collaborative editing (Tiptap + Yjs + Hocuspocus) with presence,
  remote cursors, offline editing and resynchronization
- binary Yjs persistence in PostgreSQL that survives a full server restart
- comments with inline markers, an activity panel with snapshots and restore,
  and a references panel backed by a derived link index
- deterministic Markdown export and import (frontmatter, task lists, tables,
  wiki links, callouts, stable block ids)
- attachments in S3-compatible storage with magic-byte MIME verification,
  downscaled image previews and text extraction from PDFs

**Structure**

- Notion-style databases: a database is a page, its rows are pages (ADR-011),
  with typed properties and table, board, gallery and calendar views, inline
  or full-page
- entities, their candidates and page links, in their own workspace-wide screen
- overview pages whose text is composed from the digests of their children
  (ADR-028)
- an agent memory in its own workspace, with distilled facts above its session
  notes (ADR-019, ADR-021)
- calendars: iCal import and export, reminders, event pages

**Search, AI and automation**

- PostgreSQL full-text search with trigram-tolerant titles and highlighted
  snippets, fused by reciprocal rank with `pgvector` nearest neighbours when
  semantic search is on (ADR-020)
- an AI side panel with conversations, tool calling, page context, vision
  preprocessing and reasoning levels, against OpenRouter models configured in
  the admin area or the deterministic mock provider offline
- per-workspace API keys (BYOK), a one-time budget per run and a usage view
- automations triggered from the transactional outbox (ADR-024)
- rendering Markdown to PDF through Pandoc and xelatex in a container
  (ADR-026), and LaTeX projects compiled with `latexmk` (ADR-027)

**Operating it**

- an admin area for settings, AI models, users, agent sessions and usage, with
  deployment-wide keys a workspace may override (ADR-023)
- API tokens with read/write/admin scopes, OAuth for remote MCP clients
  (ADR-018), and an agent journal that records what an agent changed (ADR-022)
- audit log and transactional outbox for destructive and reliable operations
- live background-job progress in the UI
- structured logs with a correlation id per request, and optional distributed
  tracing across API, queue, worker and the AI tool loop (ADR-031). Tracing is
  off, and its SDK is not even loaded, until a collector is configured;
  `docs/observability.md` says what a span may contain and what it never may

## Stack

| Layer    | Choice                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------- |
| Runtime  | Node.js 24 LTS, pnpm 11, Turborepo 2                                                            |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui on Base UI, Lucide, TanStack Query |
| Editor   | Tiptap 3, ProseMirror, Yjs, Hocuspocus, `y-indexeddb`                                           |
| API      | NestJS 11 with the Fastify adapter, REST + OpenAPI, Socket.IO gateway                           |
| Data     | PostgreSQL 17 with `pgvector` and `pg_trgm`, Prisma 7                                           |
| Jobs     | BullMQ 6 on Redis 8                                                                             |
| Storage  | S3-compatible (MinIO locally)                                                                   |
| Auth     | Better Auth 1.6 with the Prisma adapter                                                         |
| AI       | provider-neutral contracts, OpenRouter, a mock provider for offline work                        |
| Agents   | one tool catalogue over stdio MCP and `POST /api/mcp`                                           |
| Tracing  | OpenTelemetry SDK over OTLP/HTTP, optional and off by default                                   |
| Tests    | Vitest 5, Playwright 1.63                                                                       |

## Quick start

```bash
# 1. Runtime
nvm use                     # Node 24 (see .nvmrc)
corepack enable
pnpm install

# 2. Configuration
cp .env.example .env
# generate real secrets:
#   openssl rand -hex 32   -> BETTER_AUTH_SECRET
#   openssl rand -hex 32   -> COLLABORATION_TICKET_SECRET

# 3. Infrastructure (PostgreSQL, Redis, MinIO, Mailpit)
pnpm infra:up

# 4. Database
pnpm db:migrate
pnpm db:seed                # prints one-time development credentials

# 5. Run everything
pnpm dev
```

Then open <http://localhost:3210>. Mailpit is at <http://localhost:8026>, the
MinIO console at <http://localhost:9111>, the OpenAPI document at
<http://localhost:3211/docs>.

Details, ports and troubleshooting: [`docs/local-development.md`](docs/local-development.md).

## Commands

| Command                                    | Purpose                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `pnpm install`                             | install all workspace dependencies                   |
| `pnpm infra:up` / `pnpm infra:down`        | start/stop the Docker infrastructure                 |
| `pnpm dev`                                 | run web, api, collaboration and worker in watch mode |
| `pnpm build`                               | build every package and application                  |
| `pnpm lint`                                | dependency-boundary check + ESLint                   |
| `pnpm typecheck`                           | TypeScript in strict mode across the monorepo        |
| `pnpm test`                                | unit and integration tests (needs `pnpm infra:up`)   |
| `pnpm test:gates`                          | proves each hard gate can still go red               |
| `pnpm test:e2e`                            | Playwright suite against a running deployment        |
| `pnpm db:migrate` / `db:seed` / `db:reset` | database lifecycle                                   |
| `pnpm format`                              | Prettier                                             |

Before handing work over there is one entry point rather than ten:
`bash scripts/build.sh` runs the hard gates, the sequential build and the
checks; `bash scripts/deploy.sh` adds migrations, nginx, the units and the
readiness probes. There is deliberately no CI —
[`deploy/README.md`](deploy/README.md) explains why.

## Repository layout

```text
apps/web              Next.js frontend; no database, Redis or storage access
apps/api              NestJS REST API, Better Auth, realtime gateway; owns business logic
apps/collaboration    Hocuspocus server, binary Yjs persistence, ticket verification
apps/worker           BullMQ worker: materialization, indexing, AI runs, maintenance
apps/mcp              stdio JSON-RPC MCP server for external clients

packages/ai           provider-neutral AI contracts, OpenRouter, mock provider, runner contracts
packages/auth         Better Auth, policies, session verification, collaboration tickets
packages/calendar     iCalendar parsing and serialization, recurrence, reminders
packages/config       runtime-validated environment schemas
packages/contracts    zod schemas for REST DTOs, WebSocket events, job payloads
packages/database     Prisma schema, migrations, order keys, tree helpers, search adapters
packages/editor       canonical Tiptap schema, block ids, Markdown, Yjs materialization
packages/logger       structured logging, correlation ids, OpenTelemetry tracing
packages/mcp-tools    the one tool catalogue, shared by apps/mcp and the built-in AI
packages/queue        typed BullMQ queues, workers, Redis event bus
packages/storage      S3-compatible object storage, MIME sniffing, image downscaling
packages/ui           design tokens, shadcn components on Base UI, layout primitives

docs/adr/             architecture decision records
deploy/               nginx, systemd units, backup scripts, the render image
e2e/                  Playwright browser and API tests
tools/                Claude Code hooks that make this deployment an agent's memory
```

## Documentation

| Document                                                 | Contents                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [`docs/architecture.md`](docs/architecture.md)           | system overview, data flow, extension recipes                |
| [`docs/local-development.md`](docs/local-development.md) | setup, ports, seeding, troubleshooting                       |
| [`docs/security.md`](docs/security.md)                   | every security rule and where it is enforced                 |
| [`docs/ui-system.md`](docs/ui-system.md)                 | design tokens, shadcn workflow, accessibility                |
| [`docs/editor-extensions.md`](docs/editor-extensions.md) | editor schema, adding nodes, migrations                      |
| [`docs/collaboration.md`](docs/collaboration.md)         | Yjs, Hocuspocus, tickets, offline behaviour                  |
| [`docs/database-views.md`](docs/database-views.md)       | database properties, the four view types, the query engine   |
| [`docs/ai-architecture.md`](docs/ai-architecture.md)     | provider contract, runners, isolation rules                  |
| [`docs/background-jobs.md`](docs/background-jobs.md)     | queues, maintenance tasks, idempotency, failure handling     |
| [`docs/mcp.md`](docs/mcp.md)                             | the tool catalogue, both transports, adding a tool           |
| [`docs/capability-matrix.md`](docs/capability-matrix.md) | generated: which client reaches which route                  |
| [`docs/admin.md`](docs/admin.md)                         | settings, their scopes, the admin area                       |
| [`docs/automations.md`](docs/automations.md)             | triggers, actions, the allowlist                             |
| [`docs/render.md`](docs/render.md)                       | Markdown to PDF, templates, the render container             |
| [`docs/projects.md`](docs/projects.md)                   | LaTeX projects, the file tree, the build runner              |
| [`docs/overview-pages.md`](docs/overview-pages.md)       | digests, composition, when a refresh costs anything          |
| [`docs/observability.md`](docs/observability.md)         | logs, health, tracing: what is recorded and what never is    |
| [`docs/deviations.md`](docs/deviations.md)               | where the implementation deviates from the brief and why     |
| [`AGENTS.md`](AGENTS.md)                                 | rules for automated agents, including the documentation rule |
| [`CLAUDE.md`](CLAUDE.md)                                 | rules for Claude Code sessions                               |
| [`deploy/README.md`](deploy/README.md)                   | production deployment on this host                           |

The architecture decision records are in [`docs/adr/`](docs/adr/); `CLAUDE.md`
lists the ones a change must not silently reverse.

## Not built

Deliberately absent, while the architecture leaves room for each:

- public sharing of a page or workspace, billing, subscriptions, native mobile
  apps
- real Claude Code / Codex execution. `packages/ai/src/agent-runners.ts`
  defines the contract and `createUnimplementedRunner()` throws rather than
  pretending; when they are built they run from `apps/worker` in a container
- relation, rollup and formula properties. The enum values exist so adding
  them needs no destructive migration
- granular per-block permissions
- horizontal scaling beyond one host. The Redis event bus is the boundary that
  makes it possible, and nothing has been run against a second instance

## Keeping this file honest

`scripts/check-docs-current.mjs` is a hard gate in `scripts/build.sh`. It reads
the packages, queues, maintenance tasks, compose services and systemd units out
of the source and fails the build when a central document stops naming one, and
it fails on claims the tree disproves. The rule about when to update which
document is in [`AGENTS.md`](AGENTS.md).

## Licence

Not yet chosen. All third-party components are MIT-licensed (shadcn/ui, Base UI,
Tiptap, Yjs, Hocuspocus, NestJS, Next.js, Prisma, BullMQ, Better Auth).
