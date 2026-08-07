# Deployment

This directory contains the configuration used for the live deployment of
`exocortex.app` on this host.

## Topology

```text
Internet ──► nginx :443 (TLS + HTTP basic auth)
               ├─ /                → 127.0.0.1:3210   exocortex-web
               ├─ /api/, /docs     → 127.0.0.1:3211   exocortex-api
               ├─ /realtime  (ws)  → 127.0.0.1:3211   exocortex-api
               ├─ /collab    (ws)  → 127.0.0.1:3212   exocortex-collaboration
               └─ /health/         → 127.0.0.1:3211   (no basic auth)

Docker (127.0.0.1 only): PostgreSQL 5433 · Redis 6380 · MinIO 9110/9111 · Mailpit 1026/8026
```

Nothing except nginx listens on a public interface.

## Files

| File | Installed as |
| ---- | ------------ |
| `nginx/exocortex.app.conf` | `/etc/nginx/sites-available/exocortex` (symlinked into `sites-enabled`) |
| `systemd/exocortex-web.service` | `/etc/systemd/system/exocortex-web.service` |
| `systemd/exocortex-api.service` | `/etc/systemd/system/exocortex-api.service` |
| `systemd/exocortex-collaboration.service` | `/etc/systemd/system/exocortex-collaboration.service` |
| `systemd/exocortex-worker.service` | `/etc/systemd/system/exocortex-worker.service` |

## Initial setup

```bash
# TLS certificate (Let's Encrypt, auto-renewing)
sudo certbot --nginx -d exocortex.app -d www.exocortex.app --redirect

# HTTP basic auth while the deployment is private
printf 'johanna:%s\n' "$(openssl passwd -apr1 'CHANGE-ME')" \
  | sudo tee /etc/nginx/exocortex.htpasswd
sudo chown root:www-data /etc/nginx/exocortex.htpasswd
sudo chmod 640 /etc/nginx/exocortex.htpasswd

sudo cp deploy/nginx/exocortex.app.conf /etc/nginx/sites-available/exocortex
sudo ln -sfn /etc/nginx/sites-available/exocortex /etc/nginx/sites-enabled/exocortex
sudo nginx -t && sudo systemctl reload nginx

sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now exocortex-api exocortex-collaboration exocortex-worker exocortex-web
```

The `/.well-known/acme-challenge/` and `/health/` locations are exempt from basic
auth so certificate renewal and monitoring keep working.

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
# the MCP server reach the API through it. nginx and its basic auth are bypassed
# on purpose -- this never leaves the loopback interface.
API_URL=http://127.0.0.1:3211

# The API's address for the collaboration server's private write endpoint
# (ADR-016): a write that did not come from the editor is pushed into the open
# editing session through it, so the change appears live and the session cannot
# autosave over it. `/internal/` is deliberately absent from the nginx
# configuration and the process binds 127.0.0.1 only; never publish it.
COLLABORATION_INTERNAL_URL=http://127.0.0.1:3212

# Shared secret the worker uses to mint short-lived `exos_` service tokens that
# the API accepts as bearer credentials, resolving to the run's own user.
# Optional: without it the built-in AI still runs, just without tools, and logs
# a warning. Generate with `openssl rand -hex 32`.
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
curl -s https://exocortex.app/health/ready      # no basic auth needed
sudo -u johanna docker compose -f /var/www/exocortex/docker-compose.yml ps
```

Readiness reports each dependency individually:

```json
{"status":"ok","checks":{"database":"ok","redis":"ok","objectStorage":"ok"}}
```

and answers `503` when any of them is down.

## Backups

At minimum:

* `pg_dump` of the `exocortex` database — it contains the canonical `yjsState` blobs
  and every snapshot,
* the MinIO `exocortex` bucket (attachments),
* `/var/www/exocortex/.env` (secrets), stored separately from the database dump.

Losing PostgreSQL loses documents. Losing MinIO loses attachments but not documents.

## Before making the deployment public

1. Remove the `auth_basic` lines from the nginx vhost.
2. Set `requireEmailVerification: true` in `packages/auth/src/auth.ts`.
3. Re-check the rate limits in the same file for the expected traffic.
4. Add a `SECURITY.md` with a contact address.
5. Review `docs/security.md` end to end.
