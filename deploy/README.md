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
               ├─ /.well-known/oauth-*  → 127.0.0.1:3211 (rewritten to /api/auth/…)
               └─ /health/         → 127.0.0.1:3211

Docker bridge ──► nginx 172.17.0.1:3213 (no TLS)
               └─ /api/, /health/  → 127.0.0.1:3211   exocortex-api

Docker (127.0.0.1 only): PostgreSQL 5433 · Redis 6380 · MinIO 9110/9111 · Mailpit 1026/8026
```

Nothing except nginx listens on a public interface.

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

| File | Installed as |
| ---- | ------------ |
| `nginx/exocortex.app.conf` | `/etc/nginx/sites-available/exocortex` (symlinked into `sites-enabled`) |
| `systemd/exocortex-web.service` | `/etc/systemd/system/exocortex-web.service` |
| `systemd/exocortex-api.service` | `/etc/systemd/system/exocortex-api.service` |
| `systemd/exocortex-collaboration.service` | `/etc/systemd/system/exocortex-collaboration.service` |
| `systemd/exocortex-worker.service` | `/etc/systemd/system/exocortex-worker.service` |
| `fail2ban/filter.d/exocortex-auth.conf` | `/etc/fail2ban/filter.d/exocortex-auth.conf` |
| `fail2ban/jail.d/nginx.conf` | `/etc/fail2ban/jail.d/nginx.conf` |

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

* `nginx-http-auth` and `nginx-botsearch` watch the error log: HTTP basic auth
  failures (the realms still in front of Windmill and Steel) and scanners probing
  for paths that do not exist.
* `exocortex-auth` watches the **access** log for repeated `401`/`429` answers to
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
answer at the origin root, which is where a client looks and is not negotiable;
Better Auth serves them under its own base path, so nginx rewrites rather than
the application moving them. The trailing `(?:/.*)?` in the location regex is
deliberate: a client that found the endpoint at `/api/mcp` asks for
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

| File | Role |
| --- | --- |
| `deploy/infisical-sync-env.py` | Pulls the managed keys and merges them into the root `.env`. **Merge-only**: it never deletes and never rewrites a key Infisical does not manage. Dry run by default, `--apply` writes and backs up first. Never prints a value. |
| `deploy/infisical-sync-reload.sh` | Runs the sync and restarts `exocortex-worker` **only** if the file actually changed (the script exits 10 for that). A no-change run touches no live unit. |
| `deploy/systemd/exocortex-infisical-sync.{service,timer}` | Nightly at 03:40, `Persistent=true` so a rotated secret is not missed after a reboot. |
| `deploy/infisical-sync.env.example` | Template for `/var/www/exocortex/.infisical-sync.env`, which holds the machine-identity credentials and is git-ignored. |

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

**This host has 8 GB of RAM, shared with other services, and the four units keep
serving during the build. Build sequentially.** A parallel `pnpm build` (or a
`pnpm build` racing a `pnpm typecheck`) can exhaust memory and take the live
deployment down with it. The Next.js build is the memory-hungry step, so it goes
last.

1. **Check headroom.** `free -m`. If less than ~1 GB is free before you start,
   find out why first.

2. **Install.** `pnpm install --frozen-lockfile=false` — new workspace packages
   need linking. If it wants to change the lockfile in a way you did not expect,
   stop.

3. **Build the leaf packages, one at a time:**

   ```bash
   for pkg in contracts logger config editor ui database storage queue ai auth mcp-tools; do
     pnpm --filter "@exocortex/$pkg" build || break
   done
   ```

4. **Build the apps, still one at a time, web last:**

   ```bash
   for app in api collaboration worker mcp; do
     pnpm --filter "@exocortex/$app" build || break
   done
   pnpm --filter @exocortex/web build
   ```

   If a build is killed, check `dmesg | tail` for the OOM killer. Do not retry in
   a loop; free memory first.

5. **Check.** `pnpm lint`, then `pnpm typecheck` — sequentially, not together.
   Note that `pnpm test` includes integration tests that talk to the **production**
   database and Redis on this host (they create throwaway rows and clean up after
   themselves, but they are not isolated). On this deployment, prefer the
   unit-level filters: `pnpm --filter @exocortex/contracts test` and the same for
   `ai`, `mcp-tools`, `auth`, `config`, `editor`, `logger`, `storage`, `mcp`.

6. **Migrate.** `pnpm db:migrate` (`prisma migrate deploy`). Never `migrate dev`
   against this database: it can offer a reset when it sees drift. Confirm first
   with `pnpm --filter @exocortex/database exec prisma migrate status`.

7. **Seed the model registry** if it changed:
   `pnpm --filter @exocortex/database db:seed:ai-models`. Idempotent — it upserts
   by slug and re-wires vision companions.

8. **Sync nginx** if `deploy/nginx/exocortex.app.conf` changed:

   ```bash
   sudo cp deploy/nginx/exocortex.app.conf /etc/nginx/sites-available/exocortex
   sudo nginx -t && sudo systemctl reload nginx
   ```

   `/api/` is `proxy_read_timeout 300s` / `proxy_send_timeout 300s` (ADR-017):
   nothing behind it is allowed to take longer, because an AI run's own time
   budget (`ai.maxRunMs`) lives in the worker, not in an HTTP request —
   `POST /api/ai/runs` and `.../conversations/:id/messages` answer as soon as
   the job is enqueued. `/` stays at 120s; Next.js has no long-running routes.

9. **Restart**, API first (everything talks to it), web last (it is what users
   hit):

   ```bash
   sudo systemctl restart exocortex-api          # then check /health/ready
   sudo systemctl restart exocortex-collaboration
   sudo systemctl restart exocortex-worker       # must log the queue list and tools: true
   sudo systemctl restart exocortex-web
   ```

   Never `pkill -f`: a pattern like `node dist/main.js` matches the live services.
   Use `systemctl`, or an exact PID.

   The worker restart is where `reap-stale-ai-runs` first runs against
   whatever the previous deploy left behind. Right after this restart every
   run still `RUNNING` from before it has a stale or absent heartbeat, so the
   reaper (or the AI processor's own idempotency guard, if a job is still
   queued for it) closes all of them out as `ai_run_abandoned` within a
   minute — expected, but it is a burst of `ai.run.failed` events. Count
   first if that matters: `SELECT status, count(*) FROM ai_run GROUP BY
   status;`.

10. **Verify.** `systemctl is-active` for all four,
   `curl -s https://exocortex.app/health/ready`, and
   `journalctl -u <unit> -n 30 --no-pager` for startup errors.

`SIGTERM` triggers a graceful shutdown (in-flight jobs finish, pending document
stores are flushed), and every process reconnects, so the order above is about
minimizing the window in which a request hits a stale peer — not about
correctness.

## Operations

```bash
sudo systemctl status  exocortex-api
sudo journalctl -u exocortex-worker -f          # structured JSON logs
curl -s https://exocortex.app/health/ready      # no credentials needed
sudo -u johanna docker compose -f /var/www/exocortex/docker-compose.yml ps
```

Readiness reports each dependency individually:

```json
{"status":"ok","checks":{"database":"ok","redis":"ok","objectStorage":"ok"}}
```

and answers `503` when any of them is down.

## Backups

Losing PostgreSQL loses documents. Losing MinIO loses attachments but not documents.
Both are covered by `deploy/backup-to-mega.sh`, which runs every six hours from
`exocortex-backup.timer` and writes one folder per run to MEGA under
`/Backups/exocortex/<UTC-Zeitstempel>/`. The automation stack next door is covered
by the same machinery, see "The rest of the host" below.

One eXocortex snapshot holds:

| File | Contents |
| ---- | -------- |
| `database.dump.gpg` | `pg_dump -Fc` of the whole database, including the canonical `yjsState` blobs, every snapshot, the memory workspace, accounts and API tokens |
| `uploads.tar.gz.gpg` | the raw `exocortex-minio-data` volume, so object metadata survives |
| `config.tar.gz.gpg` | `.env`, the systemd units, the nginx site, `~/.claude/exocortex-memory.json` |
| `MANIFEST.txt` | sizes, SHA-256 sums, versions, git commit — plain text, readable without the passphrase |

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

| File | Contents |
| ---- | -------- |
| `windmill.dump.gpg` | scripts, flows, schedules, resources, job history |
| `infisical.dump.gpg` | the secret store. Useless on its own: every secret in it is encrypted with `INFISICAL_ENCRYPTION_KEY`, which is why the stack's `.env` travels in the same snapshot |
| `grafana.db.gpg` | the Grafana sqlite database, copied through the sqlite backup API so a running Grafana cannot tear it |
| `config.tar.gz.gpg` | `/opt/automation-stack` without `data/`: compose files, `.env`, `secrets/`, `helpers/`, `scripts/`, `monitoring/` |

A run is 8.7 MB. Left out: `data/prometheus` and `data/loki` (425 MB of time
series that regenerate themselves and describe a past nobody restores),
`data/windmill-cache`, and the raw postgres data directories the dumps replace.

Hermes is **not** covered here and does not need to be: the user timer
`hermes-backup.timer` has been writing `~/.hermes` state to
`/Backups/hermes-state/` daily since long before this, with a 14-day retention
and its own `~/.hermes/RESTORE.md`. It is unencrypted on MEGA, which is the one
difference from the snapshots above.

### Verification

`exocortex-backup-verify.timer` runs `deploy/backup-restore-test.sh` every Sunday
at 04:30 UTC over both snapshot families. It pulls the newest snapshot back out of
MEGA (not the local copy, so the upload path is tested too), checks each file
against the manifest checksum, restores the dumps into throwaway databases and
fails unless the tables a restore needs come back populated:

* eXocortex: documents, Yjs states, workspaces, users,
* Windmill: scripts and schedules,
* Infisical: secrets, projects, users.

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
