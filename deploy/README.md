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
```

`apps/web/.env` is a symlink to the same file, because Next.js only reads env files
from its own project directory and the `PUBLIC_*` values are baked into the browser
bundle at build time.

## Deploying a change

```bash
cd /var/www/exocortex
pnpm install
pnpm build                 # includes next build, which bakes PUBLIC_* values
pnpm db:migrate
sudo systemctl restart exocortex-api exocortex-collaboration exocortex-worker exocortex-web
```

Restart order does not matter: every process reconnects. `SIGTERM` triggers a
graceful shutdown (in-flight jobs finish, pending document stores are flushed).

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
