# Local development

## Requirements

- Node.js 24 LTS (`nvm use` reads `.nvmrc`)
- Corepack (`corepack enable`) — pnpm 11 is pinned in `packageManager`
- Docker with the Compose plugin, and a user in the `docker` group

## Setup

```bash
pnpm install
cp .env.example .env
```

Generate the two secrets:

```bash
openssl rand -hex 32   # BETTER_AUTH_SECRET
openssl rand -hex 32   # COLLABORATION_TICKET_SECRET
```

`@exocortex/config` validates the environment at startup. A missing or malformed
variable aborts the process with an English message that lists every offending
variable at once.

## Infrastructure

```bash
pnpm infra:up     # waits for all health checks
pnpm infra:down
pnpm infra:logs
```

Host ports are non-default so the stack can coexist with other services:

| Service       | Host port | Notes                                       |
| ------------- | --------- | ------------------------------------------- |
| PostgreSQL    | `5433`    | `pgvector/pgvector:pg17`                    |
| Redis         | `6380`    | append-only, `noeviction`                   |
| MinIO API     | `9110`    | bucket `exocortex` is created automatically |
| MinIO console | `9111`    |                                             |
| `minio-init`  | none      | one-shot: creates the bucket, then exits    |
| Mailpit SMTP  | `1026`    |                                             |
| Mailpit UI    | `8026`    | verification and reset mails land here      |
| Docling       | `5010`    | optional, see below                         |
| SearXNG       | `8090`    | optional, see below                         |

Application ports: web `3210`, api `3211`, collaboration `3212`.

`docling` is the only service `pnpm infra:up` does not need. It is a ~7.7 GB
image that reads scanned PDFs through OCR, and nothing breaks without it: leave
`DOCLING_BASE_URL` empty and PDF extraction stays on the hosted OpenRouter
engine. To turn it on:

```bash
docker compose up -d docling
# then set DOCLING_BASE_URL=http://127.0.0.1:5010 in .env and restart the worker
```

Model weights are baked into the image, so the first conversion needs no
download. Conversion is CPU-bound at roughly 1.5 seconds per page.

`searxng` is optional in the same way. It is the search half of web research
(ADR-033): a metasearch engine that forwards a query to the real engines and
merges what comes back, so a run can find an address instead of having to know
one. The fetch half is a Steel browser, which is not in this compose file
because it runs outside it (`deploy/README.md` says where).

```bash
docker compose up -d searxng
# then in .env:
#   SEARXNG_BASE_URL=http://127.0.0.1:8090
#   STEEL_BASE_URL=http://127.0.0.1:3000
# and switch `ai.webResearchEnabled` on, which defaults to off.
```

Its configuration is `deploy/searxng/settings.yml`, mounted as a single file.
Two things there are worth knowing before changing them: `search.formats` has to
list `json` or every API request answers `403`, and mounting a directory over
`/etc/searxng` instead of that one file hides the image's own template and ends
in the same `403`.

`minio-init` is the only service that is meant to be gone when `docker compose
ps` is run: it sets the bucket up once MinIO is healthy and exits. An `Exited
(0)` beside it is the success case, not a crashed container.

All data lives in named volumes (`exocortex-postgres-data`, `exocortex-redis-data`,
`exocortex-minio-data`, `exocortex-mailpit-data`).

## Database

```bash
pnpm db:migrate            # apply migrations (prisma migrate deploy)
pnpm db:seed               # users, workspace, nested example pages
pnpm db:reset              # drop, re-migrate, re-seed
pnpm --filter @exocortex/database db:studio
```

`packages/database/.env` is a symlink to the repository root `.env` so the Prisma
CLI finds `DATABASE_URL`.

#### Never apply a `prisma migrate dev` diff unread

The schema contains objects Prisma cannot express: the generated column
`document_search_index.searchVector` and four raw-SQL indexes
(`document_title_trgm_idx`, `document_property_value_json_gin`,
`document_search_index_searchVector_idx`, `document_search_index_title_trgm_idx`).
Prisma reads them as drift, so _every_ generated migration tries to drop them,
and the migration then fails halfway on the generated column:

```
ERROR: column "searchVector" of relation "document_search_index" is a generated column
```

Write the migration by hand instead: run `prisma migrate dev` to get a starting
diff, delete everything that is not your change, and apply it with
`prisma migrate deploy`. If a run already failed, clear the bookkeeping row with
`prisma migrate resolve --rolled-back <migration_name>` first. Prisma wraps each
migration in a transaction, so a failed one leaves the database untouched --
check with `\d document_search_index` before assuming otherwise.

### Seed data and credentials

`pnpm db:seed` creates the users **Johanna** (`OWNER`) and **Stefan** (`MEMBER`),
the shared workspace _eXocortex Team_ and six nested example pages whose content is
real Yjs state.

Passwords are never hardcoded. Either set them yourself:

```env
SEED_JOHANNA_PASSWORD=…
SEED_STEFAN_PASSWORD=…
```

or leave them empty and the script generates one-time passwords and prints them:

```text
  One-time development credentials (not stored anywhere else):
    johanna@exocortex.app  <generated>
    stefan@exocortex.app   <generated>
```

The seed is idempotent: re-running it rebuilds the example pages and resets the
credentials.

On a deployment that is in use, re-seeding is not an option — it would rebuild
example pages in a workspace people are working in. To issue a new password for
one account and change nothing else:

```bash
pnpm db:provision-user --email johanna@exocortex.app --reset-password
```

It prints the password once. Put it back into `.env` under
`SEED_JOHANNA_PASSWORD` / `SEED_STEFAN_PASSWORD`, which is where the end-to-end
suite reads it from.

**These two accounts are not the person who runs the deployment.** They are
`johanna@exocortex.app` and `stefan@exocortex.app` in the _eXocortex Team_
workspace, and the suite creates and deletes pages as them; pointing it at a real
account would let it loose in a real workspace. They are also ordinary users
globally — `invitations.spec.ts` asserts that a signed-in seed user gets 403 from
`/api/admin/*`, so promoting one to global `ADMIN` breaks the suite rather than
enabling anything.

## Running

```bash
pnpm dev      # web + api + collaboration + worker in watch mode
```

The browser always talks to its own origin. In development Next.js rewrites
`/api/*` to the API process, so session cookies stay first-party exactly as they do
behind nginx in production.

## Checks

```bash
pnpm lint             # dependency boundaries, then ESLint per package
pnpm typecheck
pnpm test:unit        # everything that needs no infrastructure
pnpm test:integration # *.integration.test.ts on a throwaway stack (needs Docker)
pnpm test             # both halves
pnpm test:e2e         # Playwright against a running deployment
```

### Which half a test belongs in

The file name decides, and the test-split gate
(`scripts/check-test-split.mjs`) is what keeps the name true:

| Name                            | May open                         | Run by                  |
| ------------------------------- | -------------------------------- | ----------------------- |
| `something.integration.test.ts` | the throwaway Postgres and Redis | `pnpm test:integration` |
| `something.test.ts`             | nothing but the process it is in | `pnpm test:unit`        |

`pnpm test:unit` is what `build.sh` runs and therefore what CI runs, so a unit
test that quietly connects to a database is two problems at once: red on a
machine that has no containers, and on this host pointed at the _live_ database
rather than a throwaway one. The gate reads the tests for the constructors that
open a connection (`createPrismaClient`, `new Redis`, `Test.createTestingModule`
and the rest) and names the file and the line when it finds one in the wrong
half. The fix is a `git mv`, or a fake handed to the subject instead of a real
client — most service tests already do the latter.

The other half of the gate is the manifest: a workspace with test files has to
declare `test:unit` and `test:integration`, spelled the same way everywhere,
because `turbo run test:unit` reaches a workspace only through the task it
names. Four apps once had tests that no CI run ever executed for exactly that
reason (issue #93).

### What `pnpm typecheck` covers

Every TypeScript file in the repository except the tests, and it takes three
projects per place rather than one, because a project that emits decides what
goes into the bundle:

| Project                                   | Holds                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `<workspace>/tsconfig.json`               | `src/`, the code that is built and shipped                              |
| `apps/api/tsconfig.scripts.json`          | the operator scripts: Obsidian import, deletions, prune, token creation |
| `packages/database/tsconfig.scripts.json` | the seeds, `provision-user`, `prisma.config.ts`                         |
| `tsconfig.tools.json`                     | every `vitest.config.mts`, the integration guard, `next.config.ts`      |

The three extra projects check without emitting, so nothing they cover reaches
`dist/`. They exist because "not built" was read as "not checked" for as long as
the scripts had existed: `apps/api/scripts/import-obsidian/verify.ts` had lost
every one of its imports and would have thrown a `ReferenceError` on its first
run against the live database, with lint and CI both green (issue #95).

`scripts/check-typecheck-coverage.mjs` is the gate under it. It asks `tsc
--showConfig` which files each project resolves to and compares that with the
tree, so a new file in a directory nothing covers fails the build, and so does a
`tsconfig` that no `typecheck` script runs. Test files are the one carve-out and
are tracked in issue #99.

### What the frontend tests and what it leaves to Playwright

`apps/web` has a Vitest suite of its own (issue #59), and it is deliberately
narrow. It holds state and transformation logic that fails identically with and
without a browser: the page tree's bookkeeping, the optimistic move behind a
drag, a table view's column layout, the icon ranking, the German error messages,
the diagnostic ring buffer. Each case is one function call, and a failure names
the branch rather than the pixel.

Everything a browser is actually needed for stays in `e2e/`: the editor,
drag-and-drop itself, collaboration, and whole page flows. The rule of thumb is
the runner's environment — the suite runs in `node`, so a test that would need a
DOM is a test that belongs in Playwright. The one module that talks to `window`
(`src/lib/connection-log.ts`) is handed a stub, which is also the only way to
see what it writes into storage after a bad hour.

```bash
pnpm --filter @exocortex/web test:unit
```

### Where the integration tests run

Not against the infrastructure from `pnpm infra:up`, and since issue #94 they
cannot be made to. `pnpm test:integration` is `scripts/test-integration.sh`,
which brings up a second stack from `docker-compose.test.yml` — its own
Postgres on 5435 and its own Redis on 6382, both empty — applies the migration
history to it, seeds the AI model registry, runs the suites and removes the
stack again.

```bash
pnpm test:integration                                    # all of it
bash scripts/test-integration.sh @exocortex/api          # one workspace
bash scripts/test-integration.sh --keep                  # leave it up to poke at
```

Two properties are worth knowing:

- **The tests cannot reach anything else.** `vitest.setup.integration.ts` runs
  before every integration test file and refuses the run unless `DATABASE_URL`
  and `REDIS_URL` are literally the ones the script just created. A suite
  started by hand fails with a message saying so rather than opening a
  connection to whatever `.env` points at — which on the deployment host is
  production. Nothing is exempt and there is no override flag.
- **Nothing survives the run.** Both data directories are tmpfs, so the
  database exists only in memory, and the stack is torn down before it is
  brought up as well as afterwards — the pre-flight teardown is what heals a
  run that was killed before its trap could fire. The tmpfs mounts are also
  what keeps anonymous volumes away: the Postgres and Redis images declare a
  `VOLUME`, and a container removed without `-v` leaves one behind. 919 of
  those, 46.7 GB, had accumulated from the migration gate by 2026-09-19.

A consequence worth saying out loud: the suites start against an **empty**
database, so a test may not assume anything exists that it did not create. The
one exception is the AI model registry, which the script seeds because it is
reference data rather than somebody's content.

`apps/api/scripts/delete-test-data.ts` still exists and still works. It is now
an operator tool for the leftovers of the old arrangement, not part of any test
run: it recognises test data by the accounts, which live at `@exocortex.test`
(reserved by RFC 6761, so it can never be a real address), and spares any
workspace with even one real member or anything younger than `--older-than`.

The Playwright suite reads the repository's `.env` itself
(`e2e/support/env.ts`), so on this host `pnpm test:e2e` needs no preparation at
all. It wants `SEED_JOHANNA_PASSWORD` and `SEED_STEFAN_PASSWORD` to be in there;
see "Seed data and credentials" above for how to reissue one.

Anything already exported wins over the file, which is how a run is pointed
somewhere else:

```bash
E2E_BASE_URL=https://staging.example.com pnpm test:e2e
E2E_BASIC_USER=…  E2E_BASIC_PASSWORD=…   # only if that deployment has a basic auth realm
```

Browsers are installed once with
`pnpm --filter @exocortex/e2e exec playwright install chromium --with-deps`.

The teardown (`e2e/support/global-teardown.ts`) cleans up in two halves, because
the run leaves two kinds of thing behind:

- **the workspaces it created**, one per scenario, deleted outright. The ids are
  in `e2e/.created-workspaces`:
  `pnpm --filter @exocortex/api workspaces:delete -- --ids-file e2e/.created-workspaces`
- **the pages it created in the seeded workspace it signed in to**, which cannot
  be deleted with the workspace because that workspace has to survive. The
  teardown removes everything in it that is newer than the moment the run
  started; the window is in `e2e/.run-scope`:
  `pnpm --filter @exocortex/api documents:delete -- --workspace <id> --created-after <iso>`

A window rather than a list of page ids, because tests create pages through the
tree, the editor and the API, and a list would miss whichever path someone adds
next. It was written after the seeded workspace reached 1,271 pages against the
six that belong there.

Both halves need database and object-storage access, so a run against a
deployment on another host warns and leaves things behind rather than failing.
`E2E_SKIP_CLEANUP=1` keeps everything on purpose, for inspecting what a failed
test built.

Also worth knowing: `AI_PROVIDER` is read by the suite itself. The AI test
asserts the mock provider's echo only when it is set to `mock`, so a run
against a deployment on a real provider still checks everything that does not
depend on which provider answered.

## Troubleshooting

| Symptom                                                            | Cause and fix                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `EnvironmentValidationError` on startup                            | a variable is missing; the message lists them. Compare with `.env.example`.                           |
| `permission denied … docker.sock`                                  | add your user to the `docker` group and start a new login session.                                    |
| `Environment variable not found: DATABASE_URL` from the Prisma CLI | the `packages/database/.env` symlink is missing: `ln -s ../../.env packages/database/.env`.           |
| Editor shows "Editor nicht verfügbar"                              | the collaboration server is not running, or `PUBLIC_COLLABORATION_URL` does not match the deployment. |
| Search finds nothing right after typing                            | persistence and materialization are debounced (about 2 s each). Watch the job progress indicator.     |
| `Too many requests` while logging in                               | the deliberate sign-in rate limit (10/minute per IP). Wait a minute.                                  |
| Browser bundle points at `localhost` in production                 | `next build` needs the env file: check the `apps/web/.env` symlink and rebuild.                       |
