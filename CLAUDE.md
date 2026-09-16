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

## Repository map

| Path                      | Responsibility                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                | Next.js frontend (App Router). No direct database, Redis or storage access.                                                   |
| `apps/api`                | NestJS + Fastify REST API, Better Auth handler, Socket.IO gateway. Owns business logic.                                       |
| `apps/collaboration`      | Hocuspocus server, binary Yjs persistence, ticket verification.                                                               |
| `apps/worker`             | BullMQ worker: materialization, search indexing, AI runs, maintenance.                                                        |
| `apps/mcp`                | stdio JSON-RPC MCP server for external clients (Hermes, Claude Code).                                                         |
| `packages/mcp-tools`      | The one tool catalogue: shared by `apps/mcp` and the worker's AI tool loop.                                                   |
| `packages/config`         | Runtime-validated environment schemas.                                                                                        |
| `packages/contracts`      | zod schemas for REST DTOs, WebSocket events, job payloads.                                                                    |
| `packages/database`       | Prisma schema, migrations, order keys, tree helpers, full-text and hybrid search adapters.                                    |
| `packages/auth`           | Better Auth setup, session verification, authorization policies, collaboration tickets.                                       |
| `packages/editor`         | Canonical Tiptap schema, block IDs, block catalog, Markdown, Yjs materialization.                                             |
| `packages/queue`          | Typed BullMQ queues, workers, Redis event bus.                                                                                |
| `packages/storage`        | S3-compatible object storage, MIME sniffing, image downscaling.                                                               |
| `packages/ai`             | Provider-neutral AI contracts, OpenRouter, embeddings, mock provider, runner contracts.                                       |
| `packages/calendar`       | iCalendar parsing and serialization, recurrence expansion, reminder scheduling.                                               |
| `packages/logger`         | Structured logging, correlation ids, the redaction list, the tracing abstraction.                                             |
| `packages/ui`             | Design tokens, shadcn components on Base UI, layout primitives, states.                                                       |
| `e2e`                     | Playwright browser and API tests.                                                                                             |
| `tools/claude-code-hooks` | SessionStart/SessionEnd hooks that make this deployment Claude Code's memory. Plain Node, no dependencies, silent on failure. |

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

`build.sh` is the one to reach for: it runs the seven hard gates that have no
bypass (package boundaries, `.env.example` sync, brand spelling, MCP catalogue
completeness, capability parity, documentation currency, migration reproducibility)
as well as the checks below, in the right order and without racing the live units
for memory. There is deliberately
no CI; `deploy/README.md` explains why and what each step does.

The individual commands still exist and are useful while iterating:

```bash
pnpm build
pnpm lint              # dependency boundaries + ESLint, src/ of each package only
pnpm exec eslint .     # the whole repository, including scripts/ and e2e/
pnpm format            # Prettier over the tree; format:check is what build.sh runs
pnpm typecheck
pnpm test              # unit and integration tests -- the integration half talks
                       # to the PRODUCTION database on this host
pnpm test:gates        # proves each gate can still go red
pnpm test:e2e          # Playwright (needs a running deployment)
```

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
- ADR-024: automations are triggered from the outbox and nowhere else; a rule
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
  repository or its bundle.
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

## Deployment on this machine

`exocortex.app` is served by nginx with TLS and HTTP basic auth in front of four
systemd units (`exocortex-web`, `exocortex-api`, `exocortex-collaboration`,
`exocortex-worker`). See `deploy/README.md`.
