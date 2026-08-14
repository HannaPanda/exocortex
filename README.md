# eXocortex

eXocortex is a self-hostable, collaborative workspace and external brain:
hierarchical pages, real-time collaborative editing, full-text search, Markdown
interchange, background automation and an AI side panel — all in one deployment
you control.

This repository contains the production-grade **foundation** plus a complete
vertical slice that proves the architecture works end to end. Features that are
explicitly out of scope for this stage are listed under
[Deferred work](#deferred-work).

## What works today

- email/password accounts, sessions, verification and password-reset mail
- multiple workspaces with `OWNER` / `ADMIN` / `MEMBER` / `GUEST` roles
- arbitrarily nested pages with stable fractional ordering
- real-time collaborative editing (Tiptap + Yjs + Hocuspocus) with presence,
  remote cursors, offline editing and resynchronization
- binary Yjs persistence in PostgreSQL that survives a full server restart
- derived ProseMirror JSON, plain text and Markdown produced by a background
  worker
- PostgreSQL full-text search with trigram-tolerant titles and highlighted
  snippets
- deterministic Markdown export and import (frontmatter, task lists, tables,
  wiki links, callouts, stable block ids)
- attachments in S3-compatible storage with magic-byte MIME verification
- an AI side panel that streams from a local mock provider through the real
  realtime pipeline
- live background-job progress in the UI
- audit log and transactional outbox for destructive and reliable operations

## Stack

| Layer    | Choice                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------- |
| Runtime  | Node.js 24 LTS, pnpm 11, Turborepo 2                                                            |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui on Base UI, Lucide, TanStack Query |
| Editor   | Tiptap 3, ProseMirror, Yjs, Hocuspocus, `y-indexeddb`                                           |
| API      | NestJS 11 with the Fastify adapter, REST + OpenAPI, Socket.IO gateway                           |
| Data     | PostgreSQL 17 (pgvector image), Prisma 6                                                        |
| Jobs     | BullMQ 6 on Redis 8                                                                             |
| Storage  | S3-compatible (MinIO locally)                                                                   |
| Auth     | Better Auth 1.6 with the Prisma adapter                                                         |
| Tests    | Vitest 4, Playwright 1.62                                                                       |

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
| `pnpm test:e2e`                            | Playwright suite against a running deployment        |
| `pnpm db:migrate` / `db:seed` / `db:reset` | database lifecycle                                   |
| `pnpm format`                              | Prettier                                             |

## Repository layout

```text
apps/
  web/              Next.js frontend
  api/              NestJS REST API + realtime gateway
  collaboration/    Hocuspocus collaboration server
  worker/           BullMQ worker
packages/
  ai/               provider-neutral AI contracts + mock provider
  auth/             Better Auth, policies, collaboration tickets
  config/           validated environment schemas
  contracts/        shared zod contracts
  database/         Prisma schema, migrations, ordering, search adapter
  editor/           canonical editor schema, Markdown, Yjs materialization
  logger/           structured logging + tracing abstraction
  queue/            typed BullMQ queues + Redis event bus
  storage/          S3 abstraction + MIME sniffing
  ui/               design tokens and components
docs/
  adr/              architecture decision records
deploy/
  nginx/            reverse proxy configuration
  systemd/          service units
e2e/                Playwright tests
```

## Documentation

| Document                                                 | Contents                                                 |
| -------------------------------------------------------- | -------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)           | system overview, data flow, extension recipes            |
| [`docs/local-development.md`](docs/local-development.md) | setup, ports, seeding, troubleshooting                   |
| [`docs/security.md`](docs/security.md)                   | every security rule and where it is enforced             |
| [`docs/ui-system.md`](docs/ui-system.md)                 | design tokens, shadcn workflow, accessibility            |
| [`docs/editor-extensions.md`](docs/editor-extensions.md) | editor schema, adding nodes, migrations                  |
| [`docs/collaboration.md`](docs/collaboration.md)         | Yjs, Hocuspocus, tickets, offline behaviour              |
| [`docs/ai-architecture.md`](docs/ai-architecture.md)     | provider contract, runners, isolation rules              |
| [`docs/background-jobs.md`](docs/background-jobs.md)     | queues, idempotency, failure handling                    |
| [`docs/deviations.md`](docs/deviations.md)               | where the implementation deviates from the brief and why |
| [`AGENTS.md`](AGENTS.md)                                 | rules for automated agents                               |
| [`CLAUDE.md`](CLAUDE.md)                                 | rules for Claude Code sessions                           |
| [`deploy/README.md`](deploy/README.md)                   | production deployment on this host                       |

## Deferred work

Deliberately **not** implemented at this stage, while the architecture leaves room
for each of them:

- Notion-style collections, database views, formulas, rollups, calendar and Kanban
  views (the `COLLECTION` document type exists but has no behaviour)
- public sharing, billing, subscriptions, native mobile apps
- semantic embeddings (the `pgvector` extension and `DocumentEmbedding` table
  exist; no embeddings are generated)
- real OpenRouter requests (adapter skeleton only), real Claude Code / Codex
  execution (runner contracts only), autonomous agents
- a complete version-history UI (snapshot services and endpoints exist)
- granular per-block permissions
- comments and activity views (the context panel already has the tabs and
  layout for them)

## Licence

Not yet chosen. All third-party components are MIT-licensed (shadcn/ui, Base UI,
Tiptap, Yjs, Hocuspocus, NestJS, Next.js, Prisma, BullMQ, Better Auth).
