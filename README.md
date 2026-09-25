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
- an interface language per account (`de`, `en`, `es`, `fr`, `it`, `nl`, `pl`,
  `pt-BR`), kept across devices and falling back to the browser and then to
  German; the catalogues and gates are in place, and the screens are being
  moved into them area by area, so most of the interface is still German in
  every locale (issue #98, ADR-062)
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
- a blockwise comparison of two states of a page, matched on stable block
  identifiers so a moved block reads as moved, and a selective restore that
  takes single blocks back into the current content (issue #77)
- transclusion: a block that shows a page, or one section of it, without
  copying its text. The source is addressed by identity and block id, so a
  rename or a move keeps it intact; it is read as the reader, so the source's
  permissions apply where it is shown; and it expands one level, which is what
  makes a cycle impossible rather than detectable (ADR-045)
- deterministic Markdown export and import (frontmatter, task lists, tables,
  wiki links, callouts, stable block ids), with the choice of exporting a
  transclusion as the reference or as the text it shows
- attachments in S3-compatible storage with magic-byte MIME verification,
  downscaled image previews, and text extraction from PDFs (Docling locally,
  with OCR for scans) and from twelve office formats -- Word, Excel,
  PowerPoint, OpenDocument, RTF, EPUB, CSV -- through a local library call
  (ADR-050)

**Structure**

- Notion-style databases: a database is a page, its rows are pages (ADR-011),
  with typed properties and table, board, gallery and calendar views, inline
  or full-page
- entities, their candidates and page links, in their own workspace-wide screen
- overview pages whose text is composed from the digests of their children
  (ADR-028)
- an agent memory in its own workspace, with distilled facts above its session
  notes (ADR-019, ADR-021), and a checkpoint an agent takes before it compacts
  its own conversation away: the call waits for the note and fails loudly, so a
  deployment that cannot be reached is never permission to forget (ADR-046)
- quick capture into a workspace inbox: `Strg + E`, `exo_capture` or
  `POST /capture` write a thought down without choosing a place first, and the
  entry is an ordinary page from the first second (ADR-036)
- a web clipper and a share target: `/teilen` takes an address, a title and the
  selected text from the browser's bookmarklet or from the phone's share menu,
  optionally reads the page itself, and writes an ordinary page with its
  provenance in the first line (ADR-037)
- page templates: any page can be marked as one, and a new page copies its
  content, icon, cover and, within the same database, its row properties. The
  copy keeps no link back, and the title comes from a pattern like
  `Wochenreview KW{{kw}}` (ADR-039)
- filing help for new pages: candidate parents ranked from the pages that
  already exist, in the sidebar's context menu, on a page sitting in the inbox,
  and as an MCP tool
- a feature registry: `/hilfe` lists in German what the deployment can do and
  where to find it, marks what is newer than the reader's own marker, and is
  kept complete by a hard gate that refuses a tool, screen or automation
  trigger nobody described (ADR-040)
- sharing a single page outward (ADR-044): an unguessable read-only link, or a
  grant to another account that reads or writes without becoming a member of
  anything, for one page or the branch below it, optionally with an expiry and
  withdrawable while somebody has it open. A subtree grant follows the
  hierarchy, so moving a page into a shared branch shares it -- which is why the
  move says so first and the page header says so afterwards
- API tokens confined to a page or a branch: such a token reaches nothing else,
  not through search, references, listings or the trash, and a workspace-wide
  request is refused rather than filtered (ADR-044)
- calendars: iCal import and export, reminders, event pages
- push notifications on the installed app (ADR-048): an appointment about to
  start, a comment on one's own page, and an agent that has something to say
  through `exo_push_send`. A subscription is a device rather than a person, so
  the phone and the desktop accept different kinds; the payload is encrypted to
  the device, so the push service in between carries an envelope it cannot
  open; and the deployment sends nothing at all until a VAPID key pair exists
- one page for what reaches you unasked (ADR-052): an occasion — a share, a
  comment, an appointment, an agent — is named separately from the channel that
  carries it, and its preference is stored where the question lives: on the
  device for push, on the account for mail. Only pairs something actually
  delivers are offered, so there is no switch that quietly does nothing;
  switching one off means no job is enqueued rather than a job that discards
  the result. Share mail is the first notification here a person can refuse
- every mail in one layout (issue #109): templates hand over words and links,
  one renderer draws them as HTML for mail clients and as an equivalent plain
  text part, escapes everything a person or a model wrote, and takes its look
  from one mail theme; `pnpm --filter @exocortex/mail preview` shows them all

**Search, AI and automation**

- PostgreSQL full-text search with trigram-tolerant titles and highlighted
  snippets, fused by reciprocal rank with `pgvector` nearest neighbours when
  semantic search is on (ADR-020); the text extracted from a page's attachments
  is part of what it is found by, so a PDF is findable by a sentence inside it
- a context compiler for agents: one question and a character budget in,
  the verbatim passages out of several pages and workspaces that answer it,
  each with title, path, date and heading, exact keyword hits protected and no
  single page allowed the whole budget (`exo_context_compile`, ADR-061)
- saved searches, smart views and query blocks: a query over words, place,
  type, database properties, entities and a time window is stored as a
  question rather than a result list, answered again with the reader's own
  access on every look, and shown in the search area, in the navigation or as
  a live list inside a page (ADR-042)
- an AI side panel with conversations, tool calling, page context, vision
  preprocessing and reasoning levels, against OpenRouter models configured in
  the admin area or the deterministic mock provider offline
- provider routing as configuration: a request only goes to the providers
  whose window can take it (ADR-032), and among those OpenRouter sorts by
  throughput, latency or price, skips or insists on providers, as one
  deployment-wide setting that each model can override key by key (ADR-063)
- a `/chats` area that finds a conversation again: full-text search over the
  messages, a reading view of the transcript, continuing it in the panel, and
  saving it as an ordinary page
- context sources pinned to a conversation beside the open page: pages,
  database views and saved searches, each merely named or carrying its text,
  inside one shared character budget the chip row above the composer reports
  (ADR-043)
- web research, off until it is switched on: a self-hosted metasearch finds
  addresses, a headless browser reads one of the pages, and what comes back is
  foreign text, so writes stay closed for the rest of that run (ADR-030,
  ADR-033)
- per-workspace API keys (BYOK), a one-time budget per run and a usage view
- automations triggered from the transactional outbox (ADR-024) or by the clock
  (ADR-038), which fire a signed webhook, an AI prompt, or the page by mail to
  the person who wrote the rule and to nobody else (ADR-054)
- rendering Markdown to PDF through Pandoc and xelatex in a container
  (ADR-026), and LaTeX projects compiled with `latexmk` (ADR-027), imported and
  exported as a `.zip`, with the result drawn by pdf.js so that SyncTeX works
  both ways: a click in the PDF opens the source line, the caret marks its place
  on the page

**Operating it**

- an admin area for settings, AI models, users, agent sessions and usage, with
  deployment-wide keys a workspace may override (ADR-023)
- API tokens with read/write/admin scopes, OAuth for remote MCP clients
  (ADR-018), and an agent journal that records what an agent changed (ADR-022)
- all three halves of MCP on both transports: tools, resources and prompts a
  person attaches, and subscriptions that notify a client when an attached page
  changes, authorized per message rather than per connection (ADR-035)
- a connections page that lists what has access, revokes it, and prints the
  finished setup line per client, plus a Claude Code plugin installed in two
  lines (`tools/claude-code-plugin`)
- audit log and transactional outbox for destructive and reliable operations
- live background-job progress in the UI
- a public styleguide at `/design-system` that draws every token, component,
  canonical pattern and the main screen layouts (shell wide and narrow, content
  page, settings, admin, search, table) with the product's own code and fixture
  data, plus interactive accessibility and UI-language references and a
  separate area listing the open design decisions; token names and values are
  parsed from the stylesheets rather than written down twice (issue #125,
  `docs/design-system-inventory.md`)
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
| API      | NestJS 12 with the Fastify adapter, REST + OpenAPI, Socket.IO gateway                           |
| Data     | PostgreSQL 17 with `pgvector` and `pg_trgm`, Prisma 7                                           |
| Jobs     | BullMQ 6 on Redis 8                                                                             |
| Storage  | S3-compatible (MinIO locally)                                                                   |
| Auth     | Better Auth 1.7 with the Prisma adapter                                                         |
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

| Command                                    | Purpose                                                |
| ------------------------------------------ | ------------------------------------------------------ |
| `pnpm install`                             | install all workspace dependencies                     |
| `pnpm infra:up` / `pnpm infra:down`        | start/stop the Docker infrastructure                   |
| `pnpm dev`                                 | run web, api, collaboration and worker in watch mode   |
| `pnpm build`                               | build every package and application                    |
| `pnpm lint`                                | dependency boundaries, then oxlint, then ESLint        |
| `pnpm typecheck`                           | strict TypeScript: sources, operator scripts, tooling  |
| `pnpm test:unit`                           | every test that needs no infrastructure                |
| `pnpm test:integration`                    | `*.integration.test.ts` on a throwaway stack           |
| `pnpm test`                                | both halves at once                                    |
| `pnpm test:gates`                          | proves each hard gate can still go red                 |
| `pnpm test:e2e`                            | Playwright suite against a running deployment          |
| `pnpm test:styleguide`                     | screenshots, axe and keyboard checks on the styleguide |
| `pnpm db:migrate` / `db:seed` / `db:reset` | database lifecycle                                     |
| `pnpm format`                              | Prettier                                               |
| `pnpm i18n:translate --all`                | translate new or changed German messages               |

Before handing work over there is one entry point rather than ten:
`bash scripts/build.sh` runs the hard gates, the sequential build and the
checks; `bash scripts/deploy.sh` adds migrations, nginx, the units and the
readiness probes. `.github/workflows/build.yml` runs the same script on every
push and pull request, on a machine that has never seen this repository before
— [`deploy/README.md`](deploy/README.md) says what that adds and what it does
not.

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
packages/features     the feature registry: what a person can do here, in a person's words
packages/i18n         the interface languages: message catalogues, locale negotiation, translator
packages/logger       structured logging, correlation ids, OpenTelemetry tracing
packages/mail         SMTP transport and the typed mail templates, shared by API and worker
packages/mcp-tools    the one tool catalogue, shared by apps/mcp and the built-in AI
packages/queue        typed BullMQ queues, workers, Redis event bus
packages/storage      S3-compatible object storage, MIME sniffing, image downscaling
packages/ui           design tokens, shadcn components on Base UI, layout primitives

docs/adr/             architecture decision records
deploy/               nginx, systemd units, backup scripts, the render image
e2e/                  Playwright browser and API tests
integrations/         the Hermes memory provider (Python, standard library only)
tools/                the Claude Code plugin: MCP server, memory hooks, setup skill
```

## Documentation

| Document                                                               | Contents                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                         | system overview, data flow, extension recipes                           |
| [`docs/local-development.md`](docs/local-development.md)               | setup, ports, seeding, troubleshooting                                  |
| [`docs/security.md`](docs/security.md)                                 | every security rule and where it is enforced                            |
| [`docs/ui-system.md`](docs/ui-system.md)                               | design tokens, shadcn workflow, accessibility                           |
| [`docs/editor-extensions.md`](docs/editor-extensions.md)               | editor schema, adding nodes, migrations                                 |
| [`docs/collaboration.md`](docs/collaboration.md)                       | Yjs, Hocuspocus, tickets, offline behaviour                             |
| [`docs/database-views.md`](docs/database-views.md)                     | database properties, the four view types, the query engine              |
| [`docs/ai-architecture.md`](docs/ai-architecture.md)                   | provider contract, runners, isolation rules                             |
| [`docs/background-jobs.md`](docs/background-jobs.md)                   | queues, maintenance tasks, idempotency, failure handling                |
| [`docs/mail.md`](docs/mail.md)                                         | synchronous and queued mail, templates, what is logged                  |
| [`docs/notifications.md`](docs/notifications.md)                       | occasions, channels, where a preference is stored                       |
| [`docs/mcp.md`](docs/mcp.md)                                           | the tool catalogue, both transports, adding a tool                      |
| [`docs/i18n.md`](docs/i18n.md)                                         | interface languages, message catalogues, the translation tool, gates    |
| [`docs/capability-matrix.md`](docs/capability-matrix.md)               | generated: which client reaches which route                             |
| [`docs/admin.md`](docs/admin.md)                                       | settings, their scopes, the admin area                                  |
| [`docs/automations.md`](docs/automations.md)                           | triggers, actions, the allowlist                                        |
| [`docs/render.md`](docs/render.md)                                     | Markdown to PDF, Pandoc templates, the render container                 |
| [`docs/projects.md`](docs/projects.md)                                 | LaTeX projects, the file tree, the build runner                         |
| [`docs/overview-pages.md`](docs/overview-pages.md)                     | digests, composition, when a refresh costs anything                     |
| [`docs/templates.md`](docs/templates.md)                               | page templates: the sidecar, the copy, the title pattern                |
| [`docs/saved-queries.md`](docs/saved-queries.md)                       | saved searches, smart views, query blocks, the query model              |
| [`docs/sharing.md`](docs/sharing.md)                                   | page shares, public links, page-scoped tokens                           |
| [`docs/features.md`](docs/features.md)                                 | the feature registry, the coverage gate, writing an entry               |
| [`docs/observability.md`](docs/observability.md)                       | logs, health, tracing: what is recorded and what never is               |
| [`docs/deviations.md`](docs/deviations.md)                             | where the implementation deviates from the brief and why                |
| [`docs/design-review-2026-09-20.md`](docs/design-review-2026-09-20.md) | a dated snapshot: where the interface drifts from its own design system |
| [`docs/design-system-inventory.md`](docs/design-system-inventory.md)   | what the interface owns, what is canonical, duplicate or undecided      |
| [`AGENTS.md`](AGENTS.md)                                               | rules for automated agents, including the documentation rule            |
| [`CLAUDE.md`](CLAUDE.md)                                               | rules for Claude Code sessions                                          |
| [`deploy/README.md`](deploy/README.md)                                 | production deployment on this host                                      |

The architecture decision records are in [`docs/adr/`](docs/adr/); `CLAUDE.md`
lists the ones a change must not silently reverse.

## Not built

Deliberately absent, while the architecture leaves room for each:

- public sharing of a whole workspace (a page and its subtree can be shared,
  ADR-044), billing, subscriptions, native mobile
  apps
- real Claude Code / Codex execution. `packages/ai/src/agent-runners.ts`
  defines the contract and `createUnimplementedRunner()` throws rather than
  pretending; when they are built they run from `apps/worker` in a container
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

[PolyForm Noncommercial 1.0.0](LICENSE). eXocortex is **source available, not
open source**: read it, run it, host it, change it and pass it on, for any
noncommercial purpose. Charities, schools, public research and government bodies
are named in the licence as permitted uses. Making money with it is the one
thing the licence does not grant by itself.

Commercial use is a conversation rather than a refusal: johanna@hannapanda.de.
Individual grants that differ from this are recorded in
[`LICENSE-GRANTS.md`](LICENSE-GRANTS.md), and what a pull request means for the
licence is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

Nothing in the dependency tree contradicts that choice: of 852 packages, 685 are
MIT and 87 Apache-2.0, and there is no GPL or AGPL anywhere. The four weak
copyleft components (`sharp`'s libvips under LGPL, `elkjs` under EPL, `ical.js`
and `lightningcss` under MPL) are file-scoped and installed rather than
vendored. The one binary asset in the repository, `Neuropol.otf`, is CC0; its
own name table says so.

Keeping it that way is a rule and not a preference: an AGPL dependency linked
into the bundle would force the whole work to be AGPL, which this licence cannot
be. See ADR-027.
