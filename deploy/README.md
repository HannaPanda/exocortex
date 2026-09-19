# Deployment

This directory contains the configuration used for the live deployment of
`exocortex.app` on this host.

## Topology

```text
Internet ──► nginx :443 (TLS)
               ├─ /                → 127.0.0.1:3210   exocortex-web
               ├─ /api/, /docs     → 127.0.0.1:3211   exocortex-api
               ├─ /realtime  (ws)  → 127.0.0.1:3211   exocortex-api
               ├─ /collab    (ws)  → 127.0.0.1:3212   exocortex-collaboration
               ├─ /.well-known/oauth-*  → 127.0.0.1:3211 (one rewritten, one not)
               └─ /health/         → 127.0.0.1:3211

Docker bridge ──► nginx 172.17.0.1:3213 (no TLS)
               └─ /api/, /health/  → 127.0.0.1:3211   exocortex-api

Docker (127.0.0.1 only): PostgreSQL 5433 · Redis 6380 · MinIO 9110/9111 · Mailpit 1026/8026
Docker (127.0.0.1 only, web research): SearXNG 8090 · Steel 3000 (shared automation stack)
Docker (per job, no network, fed by a pipe): render and project builds
```

Nothing except nginx listens on a public interface.

The last line is not a long-running container. `exocortex-worker` starts one per
render job and per project build, hands it the input through a pipe and takes the
artifact back the same way: no bind mounts, no network, gone when the job ends
(ADR-026, ADR-027). Which image it uses is the `render.image` and
`projects.image` settings; `deploy/render-image` builds the one this deployment
points them at.

The two web-research back ends are outbound only and are never reached from the
internet: `apps/api` calls them over loopback, and nginx has no location for
either (ADR-033). SearXNG is this repository's own compose service
(`docker compose up -d searxng`, configuration in `deploy/searxng/settings.yml`).
Steel belongs to the shared automation stack in `/opt/automation-stack` and
listens on `127.0.0.1:3000`, with its DevTools port on 9223; eXocortex only ever
calls `POST /v1/scrape`. Both addresses go into `.env` as `SEARXNG_BASE_URL` and
`STEEL_BASE_URL`.

One consequence worth stating plainly, because it is invisible from the edge:
Steel fetches from **inside** the Docker network, so nginx and fail2ban never
see those requests. What stops a model from reading Grafana through it is the
address check in `apps/api/src/research/public-address.ts`, not the perimeter.

There is no HTTP basic auth in front of the application. There was one while the
deployment was private; it came off on 2026-08-09, once the things it had been
quietly covering were fixed (see `docs/security.md`). The application's own
authentication is the gate, which is what it is designed to be.

The second listener exists for automations that run in containers on this host
(the Windmill morning briefing). It predates the removal, when basic auth and a
bearer token could not share the `Authorization` header. It is kept because it
never leaves the Docker bridge and saves those callers a TLS round trip; the API
token is the real authentication either way. ufw has to let the container subnet
in:

```bash
sudo ufw allow from 172.18.0.0/16 to 172.17.0.1 port 3213 proto tcp \
  comment "Windmill -> Exocortex API (intern)"
```

## Files

| File                                               | Installed as                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `nginx/exocortex.app.conf`                         | `/etc/nginx/sites-available/exocortex` (symlinked into `sites-enabled`) |
| `systemd/exocortex-web.service`                    | `/etc/systemd/system/exocortex-web.service`                             |
| `systemd/exocortex-api.service`                    | `/etc/systemd/system/exocortex-api.service`                             |
| `systemd/exocortex-collaboration.service`          | `/etc/systemd/system/exocortex-collaboration.service`                   |
| `systemd/exocortex-worker.service`                 | `/etc/systemd/system/exocortex-worker.service`                          |
| `systemd/exocortex-backup.{service,timer}`         | `/etc/systemd/system/` — encrypted full snapshots to MEGA every 6 h     |
| `systemd/exocortex-backup-verify.{service,timer}`  | `/etc/systemd/system/` — the weekly restore test                        |
| `systemd/exocortex-backup-alert@.service`          | `/etc/systemd/system/` — `OnFailure` for the three above                |
| `systemd/exocortex-infisical-sync.{service,timer}` | `/etc/systemd/system/` — pulls secrets into `.env`                      |
| `systemd/automation-stack-backup.{service,timer}`  | `/etc/systemd/system/` — the rest of the host, see Backups              |
| `render-image/Dockerfile`                          | built by hand into the image `render.image` names                       |
| `fail2ban/filter.d/exocortex-auth.conf`            | `/etc/fail2ban/filter.d/exocortex-auth.conf`                            |
| `fail2ban/jail.d/nginx.conf`                       | `/etc/fail2ban/jail.d/nginx.conf`                                       |

## Adding a person

Self-registration is off and there is no admin endpoint that creates users, so
accounts are handed out rather than requested:

```bash
pnpm db:provision-user --email someone@example.com --name Stefan \
  --workspace "Stefans Arbeitsbereich" --role OWNER
```

That creates the account, a workspace of their own, and their membership of it.
The password is generated and printed once, stored nowhere else and never
mailed: pass it on over a channel you trust, and let them change it through
"Passwort vergessen", which reaches a real mailbox.

`--workspace-of <slug>` adds someone to a workspace that already exists instead
of creating one. The script refuses an email that already has an account, so
running it twice cannot quietly reset somebody's password.

Workspaces are isolated by membership alone: a person who is not a member gets
403, in both directions, and the deployment-wide admin area needs `User.role`
`ADMIN`, which this script never grants.

## Brute-force protection

Three fail2ban jails guard the edge, all reading `/var/log/nginx/`:

- `nginx-http-auth` and `nginx-botsearch` watch the error log: HTTP basic auth
  failures (the realms still in front of Windmill and Steel) and scanners probing
  for paths that do not exist.
- `exocortex-auth` watches the **access** log for repeated `401`/`429` answers to
  `/api/auth/sign-in/email` and the password-reset endpoints. This is the one
  that matters now that the basic auth in front of the deployment is gone,
  because the other two see nothing here: Better Auth's per-IP limit slows an
  attacker to ten guesses a minute but never stops them.

The application log is deliberately not the source. pino writes structured JSON
to the journal and does not record the client address, so there would be nothing
to ban; nginx knows the real address and writes it as the first field.

`ignoreip` covers loopback, the Hetzner private network, the Docker bridges and
fpb2, so a ban can never land on one of our own automations. After changing
either file:

```bash
sudo fail2ban-client -t                      # validate
sudo systemctl restart fail2ban
sudo fail2ban-client status exocortex-auth   # confirm the jail is live
```

To check a filter against real traffic before trusting it:

```bash
sudo fail2ban-regex /var/log/nginx/access.log /etc/fail2ban/filter.d/exocortex-auth.conf
```

Note that fail2ban here bans through **nftables**, not iptables
(`jail.d/defaults-debian.conf` sets `banaction = nftables`). Looking for an
`f2b-*` chain in `iptables -L` finds nothing and proves nothing; the rules live
in `nft list table inet f2b-table`.

## Initial setup

```bash
# TLS certificate (Let's Encrypt, auto-renewing)
sudo certbot --nginx -d exocortex.app -d www.exocortex.app --redirect

# Optional: an HTTP basic auth realm in front of everything, for a deployment
# that should not be reachable at all yet. exocortex.app does not use one.
# If you add it, use bcrypt -- apr1 is MD5 and falls to a GPU in seconds if the
# file ever leaks -- and let `htpasswd -B` prompt, so the password stays out of
# the shell history. Remember that /.well-known/acme-challenge/ and /health/
# have to stay exempt, and that a bearer token cannot share the Authorization
# header with basic auth.
#   sudo htpasswd -B -c /etc/nginx/exocortex.htpasswd johanna
#   sudo chown root:www-data /etc/nginx/exocortex.htpasswd
#   sudo chmod 640 /etc/nginx/exocortex.htpasswd

sudo cp deploy/nginx/exocortex.app.conf /etc/nginx/sites-available/exocortex
sudo ln -sfn /etc/nginx/sites-available/exocortex /etc/nginx/sites-enabled/exocortex
sudo nginx -t && sudo systemctl reload nginx

sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exocortex-api exocortex-collaboration exocortex-worker exocortex-web
```

`/.well-known/acme-challenge/` is served from disk so certificate renewal keeps
working, and `/health/` reaches the API without a session so monitoring can probe
it. Both were also the two exemptions the old basic auth realm needed; if you put
one back, they have to stay exempt.

The two `/.well-known/oauth-*` locations are OAuth discovery for remote MCP
clients ([ADR-018](../docs/adr/ADR-018-remote-mcp-over-http.md)). They must
answer at the origin root, which is where a client looks and is not negotiable.
The two are handled differently because the library answers them differently:
the authorization-server document is a route under Better Auth's base path, so
nginx rewrites onto it, while the protected-resource document is served by a
request hook in `@better-auth/mcp` that matches the real path, so that one is
proxied untouched. Rewriting it would hide the path the hook looks for. The
trailing `(?:/.*)?` in the location regex is deliberate: a client that found the
endpoint at `/api/mcp` asks for
`/.well-known/oauth-authorization-server/api/mcp` before it asks for the bare
path. If you put a basic auth realm back, these two need the same exemption as
the ACME challenge, or ChatGPT cannot discover anything.

## Configuration

All four services read `/var/www/exocortex/.env` through `@exocortex/config`
(`WorkingDirectory` is inside the repository). For this host:

```env
NODE_ENV=production
APP_URL=https://exocortex.app
BETTER_AUTH_URL=https://exocortex.app
PUBLIC_API_URL=https://exocortex.app
PUBLIC_COLLABORATION_URL=wss://exocortex.app/collab

# Internal base URL for server-to-server calls: the worker's AI tool loop and
# the MCP server reach the API through it. nginx is bypassed
# on purpose -- this never leaves the loopback interface.
API_URL=http://127.0.0.1:3211

# The API's address for the collaboration server's private write endpoint
# (ADR-016): a write that did not come from the editor is pushed into the open
# editing session through it, so the change appears live and the session cannot
# autosave over it. `/internal/` is deliberately absent from the nginx
# configuration and the process binds 127.0.0.1 only; never publish it.
COLLABORATION_INTERNAL_URL=http://127.0.0.1:3212

# Shared secret for short-lived `exos_` service tokens, which the API accepts as
# bearer credentials resolving to the acting user. Two processes mint them: the
# worker, once per AI run, and the API itself, once per MCP request from a
# client that authenticated with OAuth and therefore holds no `exo_` token.
# Optional, but the cost of leaving it out is now larger: the built-in AI runs
# without tools, and `/api/mcp` refuses every OAuth client (an `exo_` token
# still works). Generate with `openssl rand -hex 32`.
SERVICE_TOKEN_SECRET=<64 hex characters>
SERVICE_TOKEN_TTL_SECONDS=300
```

`apps/web/.env` is a symlink to the same file, because Next.js only reads env files
from its own project directory and the `PUBLIC_*` values are baked into the browser
bundle at build time. `packages/database/.env` is a symlink to it as well, so
there is exactly one file to edit: `/var/www/exocortex/.env`.

Everything that is a preference rather than a secret now lives in the `setting`
table and overrides the environment at runtime (ADR-013). The `.env` file stays
the bootstrap fallback, so all four units boot with an empty `setting` table.
See `docs/admin.md` for the full key list.

### Secrets that come from Infisical

Some credentials are not edited in `.env` at all. Infisical (project
`Exocortex`, id `83526c90-de12-446f-afcd-26adc138c01c`, environment `prod`,
secret path `/`) is the source of truth, and a nightly timer merges them in:

| File                                                      | Role                                                                                                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/infisical-sync-env.py`                            | Pulls the managed keys and merges them into the root `.env`. **Merge-only**: it never deletes and never rewrites a key Infisical does not manage. Dry run by default, `--apply` writes and backs up first. Never prints a value. |
| `deploy/infisical-sync-reload.sh`                         | Runs the sync and restarts `exocortex-worker` **only** if the file actually changed (the script exits 10 for that). A no-change run touches no live unit.                                                                        |
| `deploy/systemd/exocortex-infisical-sync.{service,timer}` | Nightly at 03:40, `Persistent=true` so a rotated secret is not missed after a reboot.                                                                                                                                            |
| `deploy/infisical-sync.env.example`                       | Template for `/var/www/exocortex/.infisical-sync.env`, which holds the machine-identity credentials and is git-ignored.                                                                                                          |

Managed today: `MAILBOX_CALDAV_URL`, `MAILBOX_CALDAV_USERNAME`,
`MAILBOX_CALDAV_PASSWORD`. A secret still sitting at the placeholder
`BITTE_EINTRAGEN` is skipped rather than written, so a half-configured project
cannot put that literal string into the environment.

```bash
# What would change, without touching anything
python3 deploy/infisical-sync-env.py

# Apply now instead of waiting for the timer
sudo systemctl start exocortex-infisical-sync.service
sudo journalctl -u exocortex-infisical-sync -n 20 --no-pager
```

Rotating a credential means editing it in Infisical, not here: the next run
overwrites the `.env` value. Only the worker is restarted, because it is the
only process that reads these; bouncing the API or collaboration server would
drop live editing sessions for nothing.

## Deploying a change

```bash
bash scripts/deploy.sh
```

That is the whole of it. This section describes what the script does and why,
so a failure part-way through is readable; it is not a list to type out. There
was one until 2026-08-14, and the trouble with a manual is that steps get
skipped, the order drifts from session to session, and nothing records which
commit actually went live.

### Two scripts, one boundary

`scripts/build.sh` answers "is this commit healthy" and **starts nothing**. It
can be run at any time, including on a machine that is serving nothing.
`scripts/deploy.sh` calls it and then does everything that touches the running
system. Nothing above that line lives in `deploy.sh`, and nothing below it lives
in `build.sh`.

```bash
bash scripts/build.sh                 # validate and build, touch no service
bash scripts/build.sh --skip-checks   # hard gates only, no lint/typecheck/tests
bash scripts/build.sh --full-tests    # also the tests that use the live database
bash scripts/deploy.sh --dry-run      # everything up to the first change, then stop
```

### What build.sh does

0. **Working tree must be clean.** Hard, first, and not covered by
   `--skip-checks`. Everything downstream identifies a deployment by its commit;
   an uncommitted file changes what gets built without changing what the markers
   record.
1. **Headroom.** Under 1 GB available is a refusal, under 2 GB a warning. This
   host has 16 GB shared with everything else on it, the four units keep serving
   throughout, and the Next.js build alone can summon the OOM killer — which does
   not pick its victim carefully and may take a live unit instead.
2. **`pnpm install --frozen-lockfile`.** A build installs exactly what the commit
   records. If the lockfile is behind, run `pnpm install` by hand and commit it.
3. **Prisma client**, before anything type-checks against it.
4. **The hard gates.** Always on, no bypass, roughly six seconds together:

   | Gate                               | Catches                                                                                                                                   |
   | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
   | `check-dependency-boundaries.mjs`  | a manifest depending on a package the graph forbids                                                                                       |
   | `check-env-example.mjs`            | a variable the code reads and `.env.example` does not document, or the reverse                                                            |
   | `check-brand-spelling.mjs`         | `Exocortex` where a human reads it (rule 10)                                                                                              |
   | `check-mcp-catalog.mjs`            | a REST route with no tool behind it, and a tool calling a route that is gone (rule 11, ADR-014)                                           |
   | `check-capability-parity.mjs`      | a tool the built-in AI does not get, a screen no agent can reach, a stale matrix (rule 12, ADR-025)                                       |
   | `check-feature-coverage.mjs`       | a tool, screen or automation trigger the feature registry does not describe, and a claim that matches nothing (rule 15, ADR-040)          |
   | `check-docs-current.mjs`           | a package, queue, maintenance task, compose service or unit no central document names, and claims the tree disproves (rule 13, issue #58) |
   | `check-test-split.mjs`             | a unit test that opens a database, and a workspace whose tests no CI run executes (issue #93)                                             |
   | `check-migrations-reproducible.sh` | a migration history that does not rebuild `schema.prisma` from zero                                                                       |

   Each one prints its findings and one sentence on how to fix them. The
   migration gate replays the whole history onto a throwaway Postgres container
   and never touches the live database.

5. **Build**, one package at a time in dependency order, web last. The order
   comes out of `scripts/dependency-graph.mjs`, so a new package cannot be
   forgotten. `.build-marker` records which commit the artefacts belong to, and
   a matching marker skips the build.
6. **Soft checks**, skippable with `--skip-checks`: `eslint .` from the root
   (each package lints `src` only, which leaves the root scripts, `apps/api/scripts`
   and `e2e` unseen), `pnpm format:check`, `pnpm typecheck`, the gate tests, and
   `pnpm test:unit` — every test in every workspace that needs no
   infrastructure. `--full-tests` adds `pnpm test:integration`, which brings up
   a Postgres and a Redis of its own (`docker-compose.test.yml`), migrates
   them, runs the suites and removes them again. Until issue #94 those suites
   talked to the **production** database on this host; a guard now refuses any
   connection but the throwaway one, so the flag is a question of half a minute
   of container startup rather than of risk.

   Which half a test is in follows from its name (`*.integration.test.ts`) and
   is enforced by the test-split gate above. Until issue #93 the default step
   named twelve packages by hand instead, so nothing under `apps/` was ever run
   by CI, and nine failing tests sat on `master` behind a green build.

   `format:check` is a soft check rather than a hard gate on purpose: an
   unformatted file is not a wrong file. It only became runnable in `73009f7`,
   which is `prettier --write .` over 315 files and nothing else — a config had
   been describing the repository since the first commit without ever having been
   applied to it. Fix a red one with `pnpm format`, and keep the reformat out of
   the commit that caused it.

### What deploy.sh adds

7. **Where we are.** Refuses when `origin/master` has commits this checkout does
   not; warns when HEAD is unpushed. No `git pull` — development and deployment
   are the same host here, so there is nothing to fetch.
8. **Migrations.** `prisma migrate status` first so the pending list is on screen,
   then `pnpm db:migrate` (`prisma migrate deploy`). Never `migrate dev` against
   this database: it offers a reset when it sees drift, and the drift it sees
   here is the search index it cannot model.
9. **Model registry**, only when `seed-ai-models.ts` changed since the deployed
   commit. Idempotent either way — it upserts by slug and re-wires vision
   companions — but it is still a write against the live database.
10. **nginx**, only when the configuration changed. The new file is installed,
    tested with `nginx -t`, and restored from a backup if the test fails: `nginx -t`
    can only judge what is installed, so without the restore a rejected file
    would sit in `sites-available` waiting for an unrelated reload days later.

    `/api/` is `proxy_read_timeout 300s` / `proxy_send_timeout 300s` (ADR-017):
    nothing behind it is allowed to take longer, because an AI run's own time
    budget (`ai.maxRunMs`) lives in the worker, not in an HTTP request —
    `POST /api/ai/runs` and `.../conversations/:id/messages` answer as soon as
    the job is enqueued. `/` stays at 120s; Next.js has no long-running routes.

11. **The API's module graph**, compiled once before any unit is touched
    (`app.module.integration.test.ts`). It catches the one failure that is invisible to
    everything else: a module that injects a provider it does not list compiles,
    type-checks, passes every unit test and then refuses to boot. The test needs
    Postgres and Redis, so `build.sh` leaves it out of its default set — and
    that is how issue #83 got a green build and a dead API. Here is still
    before the restart.

    It gets those two from `scripts/test-integration.sh --run` rather than from
    the deployment (issue #94): what it needs is _a_ database, not _the_
    database. Everything else about the configuration is still the real one,
    and compiling the graph no longer has Better Auth write its OAuth resource
    rows into production on every deploy.

12. **Restart**, API first (everything talks to it), web last (it is what people
    have open):

    ```text
    exocortex-api → exocortex-collaboration → exocortex-worker → exocortex-web
    ```

    `SIGTERM` is a graceful shutdown everywhere (in-flight jobs finish, pending
    document stores are flushed) and every process reconnects, so the order is
    about shrinking the window in which a request meets a stale peer, not about
    correctness.

    Never `pkill -f`: a pattern like `node dist/main.js` matches the live
    services. Use `systemctl`, or an exact PID.

13. **Readiness**, `/health/ready` with up to fifteen tries two seconds apart,
    then `systemctl is-active` for all four.
14. **The marker.** `.last-deployed-sha` is written last and only on full
    success, so a rollout that fell over halfway leaves nothing behind claiming
    it worked, and the next run does everything again rather than believing this
    one.

### Expected right after a deploy

The worker restart is where `reap-stale-ai-runs` meets whatever the previous
deployment left mid-flight. Every run still `RUNNING` from before has a stale or
absent heartbeat, so the reaper — or the AI processor's own idempotency guard, if
a job is still queued for it — closes all of them out as `ai_run_abandoned`
within a minute. That is a burst of `ai.run.failed` events and it is not a
failure. Count first if it matters:
`SELECT status, count(*) FROM ai_run GROUP BY status;`.

### When a build is killed rather than failing

That is the OOM killer, not a bug in the code. Check `dmesg | tail`, free memory,
and do not retry in a loop.

### Tracing, when a question needs a timeline

On, and pointed at Grafana Tempo. `OTEL_EXPORTER_OTLP_ENDPOINT` in `.env` names
`http://127.0.0.1:4318`, which is the `tempo` container of the automation stack
(`/opt/automation-stack/docker-compose.monitoring.yml`, config in
`monitoring/tempo/config.yml`). The port is bound to loopback: the senders are
the units on this machine and nothing else.

Emptying the endpoint line and restarting the units switches it off again, and
off means the SDK is not loaded at all rather than merely quiet.

**Where to look.** <https://grafana.hannapanda.de>, folder **eXocortex**,
dashboard **eXocortex**. Five rows: overview, API, queue, AI, and a pair of
look-up panels (the slowest traces, and the log lines). Everything on it is
computed from the spans themselves through TraceQL metrics, because the
application has no Prometheus endpoint and Tempo's metrics generator was
deliberately not switched on. **Explore → tempo** is the same data without the
frame. One trace covers a request, the jobs it enqueues, the AI run those start
and every tool call underneath it (ADR-031).

The dashboard is provisioned from
`/opt/automation-stack/monitoring/grafana/dashboards/exocortex/`, so it is not
editable in the browser: change the file, and Grafana reloads it within thirty
seconds.

**How long things are kept.** Two different numbers, on purpose.

| Store          | Kept     | Why                                                                    |
| -------------- | -------- | ---------------------------------------------------------------------- |
| Loki (logs)    | 180 days | asked about months later, and it costs ~4.5 MB a day                   |
| Tempo (traces) | 30 days  | diagnosis, not a record; ~500 MB a day raw, and 180 days would not fit |

Both were measured on 2026-09-16 with 41 GB free. If traces need to reach
further back, lower `OTEL_TRACES_SAMPLER_RATIO` rather than raising the
retention: fewer traces kept longer beats more traces kept briefly, and the
sampler is parent-based, so a kept trace is still complete.

**Logs of a trace.** The four `exocortex-*` units are shipped into Loki by the
`main-exocortex` job in `/opt/automation-stack/monitoring/promtail-main/config.yml`,
which also unpacks pino's JSON far enough to make `level` a label. A span's
"logs for this span" button in Grafana therefore works. Directly:
`journalctl -u exocortex-worker -o cat | grep <traceId>`.

Better Auth emits spans of its own (`GET /get-session`, `handler …`,
`db findOne …`) as soon as a global tracer exists. They are not ours and the
dashboard's API panels filter them out by route name; in Explore they are simply
there.

`docs/observability.md` has the variables, the table of which span is opened
where, and the rule about what a span may never contain.

### What the CI adds

For a long time there was none, and the reasoning held: one person, always on
`master`, and checks that belong where the deployment happens. What it missed is
that this host is not a neutral witness. It has a warm `node_modules`, a
`.build-marker` from the last build, a root `.env`, generated Prisma output and
four units running the previous commit. A commit that builds here is not yet a
commit that builds.

`.github/workflows/build.yml` is that second opinion and nothing more. It
installs Node and pnpm and runs `bash scripts/build.sh` — the same script, the
same gates, the same order, on a checkout that has never seen this repository.
The workflow file itself contains no checks, on purpose: a rule that lives in
the workflow instead of the script is a rule the deploy does not know about.

It needs no secrets and touches nothing here. Its databases are throwaway
containers: the migration gate's, and the integration tests' own Postgres and
Redis, which it runs because the workflow calls `build.sh --full-tests`
(issue #94).

What it deliberately does not do: the Playwright
suite, and anything resembling a deployment. `scripts/deploy.sh` on this machine
stays the only thing that puts code in front of a user, and it runs `build.sh`
again rather than trusting a green tick from somewhere else.

A run takes around a quarter of an hour, and a private repository pays for its
minutes, so the workflow cancels an older run on the same ref when a new push
lands.

## Operations

```bash
sudo systemctl status  exocortex-api
sudo journalctl -u exocortex-worker -f          # structured JSON logs
curl -s https://exocortex.app/health/ready      # no credentials needed
sudo -u johanna docker compose -f /var/www/exocortex/docker-compose.yml ps
```

Readiness reports each dependency individually:

```json
{ "status": "ok", "checks": { "database": "ok", "redis": "ok", "objectStorage": "ok" } }
```

and answers `503` when any of them is down.

## Backups

Losing PostgreSQL loses documents. Losing MinIO loses attachments but not documents.
Both are covered by `deploy/backup-to-mega.sh`, which runs every six hours from
`exocortex-backup.timer` and writes one folder per run to MEGA under
`/Backups/exocortex/<UTC-Zeitstempel>/`. The automation stack next door is covered
by the same machinery, see "The rest of the host" below.

One eXocortex snapshot holds:

| File                 | Contents                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `database.dump.gpg`  | `pg_dump -Fc` of the whole database, including the canonical `yjsState` blobs, every snapshot, the memory workspace, accounts and API tokens |
| `uploads.tar.gz.gpg` | the raw `exocortex-minio-data` volume, so object metadata survives                                                                           |
| `config.tar.gz.gpg`  | `.env`, the systemd units, the nginx site, `~/.claude/exocortex-memory.json`                                                                 |
| `MANIFEST.txt`       | sizes, SHA-256 sums, versions, git commit — plain text, readable without the passphrase                                                      |

Snapshots are full, not incremental: a run is about 36 MB and takes eight
seconds, which is cheaper than the machinery an incremental scheme needs, and it
keeps a restore down to two commands. Revisit that when the uploads pass ~20 GB;
`restic` over `rclone` is the next step, not a bigger shell script.

Everything is encrypted with GPG (symmetric, AES256). The passphrase lives in
`/etc/exocortex/backup-passphrase` (`root:johanna`, `0640`) and in the Second
Brain page "eXocortex-Backups auf MEGA". **Both copies sit on this host. Keep a
third one in a password manager, or a dead machine takes the key with it.**

Retention is pruned on every run and the buckets overlap: the last 8 snapshots,
the newest of each of the last 14 days, of the last 8 weeks and of the last 6
months. That settles at roughly 29 snapshots, about 1 GB.

Redis is deliberately absent: it only holds BullMQ queues, which rebuild from the
outbox and the next materialization run.

### The rest of the host

`deploy/backup-stack-to-mega.sh` does the same for the automation stack in
`/opt/automation-stack`, daily at 02:15 UTC from `automation-stack-backup.timer`,
into `/Backups/automation-stack/<UTC-Zeitstempel>/`. Both scripts share
`deploy/backup-lib.sh`, so the retention arithmetic exists exactly once: a bug in
it deletes backups rather than failing loudly.

| File                 | Contents                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windmill.dump.gpg`  | scripts, flows, schedules, resources, job history                                                                                                                   |
| `infisical.dump.gpg` | the secret store. Useless on its own: every secret in it is encrypted with `INFISICAL_ENCRYPTION_KEY`, which is why the stack's `.env` travels in the same snapshot |
| `grafana.db.gpg`     | the Grafana sqlite database, copied through the sqlite backup API so a running Grafana cannot tear it                                                               |
| `config.tar.gz.gpg`  | `/opt/automation-stack` without `data/`: compose files, `.env`, `secrets/`, `helpers/`, `scripts/`, `monitoring/`                                                   |

A run is 8.7 MB. Left out: `data/prometheus` and `data/loki` (425 MB of time
series that regenerate themselves and describe a past nobody restores),
`data/windmill-cache`, and the raw postgres data directories the dumps replace.

Hermes is **not** covered here and does not need to be: the user timer
`hermes-backup.timer` has been writing `~/.hermes` state to
`/Backups/hermes-state/` daily since long before this, with a 14-day retention
and its own `~/.hermes/RESTORE.md`. Since 2026-08-12 those archives are encrypted
with the same passphrase, so one key opens everything on MEGA. Its script refuses
to run rather than fall back to a plaintext upload when the passphrase is
unreadable.

### Verification

`exocortex-backup-verify.timer` runs `deploy/backup-restore-test.sh` every Sunday
at 04:30 UTC over both snapshot families. It pulls the newest snapshot back out of
MEGA (not the local copy, so the upload path is tested too), checks each file
against the manifest checksum, restores the dumps into throwaway databases and
fails unless the tables a restore needs come back populated:

- eXocortex: documents, Yjs states, workspaces, users,
- Windmill: scripts and schedules,
- Infisical: secrets, projects, users.

A failure in any unit triggers `exocortex-backup-alert@.service`, which sends the
journal tail to Telegram through `hermes send`.

### Restoring

```bash
# 1. Fetch and decrypt
mega-get /Backups/exocortex/<stamp>/database.dump.gpg .
mega-get /Backups/exocortex/<stamp>/uploads.tar.gz.gpg .
gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/exocortex/backup-passphrase \
  --decrypt --output database.dump database.dump.gpg

# 2. Database
sudo systemctl stop exocortex-api exocortex-worker exocortex-collaboration exocortex-web
docker exec -i exocortex-postgres pg_restore -U exocortex -d exocortex \
  --clean --if-exists --no-owner < database.dump

# 3. Uploads, with MinIO stopped so it does not fight the extraction
gpg --batch --pinentry-mode loopback \
  --passphrase-file /etc/exocortex/backup-passphrase \
  --decrypt uploads.tar.gz.gpg > uploads.tar.gz
docker stop exocortex-minio
docker run --rm -v exocortex-minio-data:/data -v "$PWD:/in" alpine \
  sh -c 'rm -rf /data/* && tar xzf /in/uploads.tar.gz -C /data'
docker start exocortex-minio
sudo systemctl start exocortex-collaboration exocortex-api exocortex-worker exocortex-web
```

Restoring the database is enough to get the documents back; the attachments are
independent and can follow later. Open editing sessions must be reconnected
afterwards: the collaboration server holds a Yjs document in memory that no
longer matches the database (ADR-016).

## Before making the deployment public

1. Remove the `auth_basic` lines from the nginx vhost.
2. Set `requireEmailVerification: true` in `packages/auth/src/auth.ts`.
3. Re-check the rate limits in the same file for the expected traffic.
4. Add a `SECURITY.md` with a contact address.
5. Review `docs/security.md` end to end.
