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
pnpm lint         # dependency boundaries, then ESLint per package
pnpm typecheck
pnpm test         # unit + integration (requires pnpm infra:up)
pnpm test:e2e     # Playwright against a running deployment
```

### What a test run leaves behind

The integration suites create a workspace and a few accounts each and delete them
in `afterAll` — which does not run when the process is killed, and that is
exactly when the mess is made. Interrupted runs had left 21 workspaces by
2026-08-12, in `Collab`/`Worker` pairs created in the same second, because two
packages test in parallel and an interrupt takes both.

`pnpm test` therefore sweeps _before_ it starts, which is the only moment that
catches a run nobody finished:

```bash
pnpm --filter @exocortex/api test-data:prune -- [--older-than 2] [--dry-run]
```

It recognises test data by the accounts: they live at `@exocortex.test`, and
`.test` is reserved by RFC 6761 so it can never be a real address. A workspace
whose members are _all_ such accounts was made by a test run and by nothing else.
One real member is enough to spare it, and nothing younger than `--older-than`
(two hours) is touched, so a suite running in another terminal keeps its ground.

A name prefix would have been the obvious rule and the wrong one: it needs
updating whenever a suite invents a name, and it would happily match a real
workspace somebody called "Docs".

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
