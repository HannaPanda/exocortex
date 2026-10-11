#!/usr/bin/env bash
#
# One command for the Firefox WebSocket harness (issue #166): set up, run,
# tear down.
#
#   bash e2e/firefox-harness/run.sh [--web <label>] [--keep] [-- <harness.mjs options>]
#
#   --web <label>   which harness web build to serve (default: baseline);
#                   built on demand with build-web.sh if it does not exist
#   --keep          leave Postgres and Redis running afterwards
#
# Everything after `--` goes to harness.mjs, for example
#   bash e2e/firefox-harness/run.sh -- --label baseline --cycles 30
#   bash e2e/firefox-harness/run.sh -- --label control --no-exo --cycles 30
#
# What it never does: touch the live units, the live database, the live Redis
# or the live bucket. The services run from the deployed build artefacts but
# as children of harness.mjs, on the ports in ports.sh, with a complete
# environment and no `.env`; the infrastructure is its own compose project on
# tmpfs, torn down on exit (also on Ctrl-C).
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$DIR/../.." && pwd)
# shellcheck source=ports.sh
source "$DIR/ports.sh"

WEB_LABEL=baseline
KEEP=0
HARNESS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --web) shift; WEB_LABEL="$1" ;;
    --keep) KEEP=1 ;;
    --) shift; HARNESS_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

compose() { docker compose -p exocortex-ffharness -f "$DIR/docker-compose.yml" "$@"; }
teardown() { compose down -v --remove-orphans --timeout 10 >/dev/null 2>&1 || true; }

echo "▸ tools"
bash "$DIR/setup-tools.sh"

for port in "$HARNESS_PROXY_PORT" "$HARNESS_API_PORT" "$HARNESS_COLLAB_PORT" "$HARNESS_WEB_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is in use; is another harness run still going?" >&2
    exit 1
  fi
done

if [ ! -f "$ROOT_DIR/apps/web/.next-harness-$WEB_LABEL/BUILD_ID" ]; then
  echo "▸ web build $WEB_LABEL"
  bash "$DIR/build-web.sh" "$WEB_LABEL"
fi
for artefact in apps/api/dist/main.js apps/collaboration/dist/main.js; do
  [ -f "$ROOT_DIR/$artefact" ] || { echo "$artefact is missing; run pnpm build first" >&2; exit 1; }
done

echo "▸ infrastructure"
teardown
if [ "$KEEP" -eq 0 ]; then trap teardown EXIT INT TERM; fi
compose up -d --wait

export DATABASE_URL="postgresql://ffharness:ffharness@127.0.0.1:${HARNESS_PG_PORT}/ffharness?schema=public"
case "$DATABASE_URL" in *":5433/"*) echo "refusing the production database" >&2; exit 1 ;; esac

echo "▸ migrations"
(cd "$ROOT_DIR" && pnpm --filter @exocortex/database db:migrate >/dev/null)

echo "▸ test account"
export HARNESS_EMAIL="firefox-harness@exocortex.test"
PROVISION_OUT=$(cd "$ROOT_DIR" && pnpm --silent --filter @exocortex/database db:provision-user -- \
  --email "$HARNESS_EMAIL" --name "Firefox Harness" --workspace "Firefox Harness")
HARNESS_PASSWORD=$(printf '%s\n' "$PROVISION_OUT" | awk '/One-time password/{getline; gsub(/ /,""); print}')
[ -n "$HARNESS_PASSWORD" ] || { echo "could not read the provisioned password" >&2; printf '%s\n' "$PROVISION_OUT" >&2; exit 1; }
export HARNESS_PASSWORD
unset DATABASE_URL

echo "▸ harness"
cd "$DIR"
node harness.mjs --web "$WEB_LABEL" "${HARNESS_ARGS[@]}"
