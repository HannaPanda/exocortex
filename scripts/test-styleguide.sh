#!/usr/bin/env bash
#
# The styleguide gate (issue #127): screenshots, axe and keyboard checks
# against /design-system.
#
#   bash scripts/test-styleguide.sh                     every styleguide test
#   bash scripts/test-styleguide.sh visual.spec.ts      only the screenshots
#   bash scripts/test-styleguide.sh --update-snapshots  rewrite the baselines
#
# Needs the web build (`build.sh` step 5 made it) and Docker. It serves that
# build with `next start` on a port of its own, so it touches no live unit and
# runs the same way in CI, where nothing is deployed. The page is public and
# draws only local fixtures, so the server needs no API, no database and no
# session behind it.
#
# The browser runs in the Playwright image pinned below, never on the host.
# A baseline is only comparable with a screenshot rasterised by the same
# Chromium, the same fonts and the same FreeType, and the host's differ from
# a CI runner's in antialiasing alone. The version must match @playwright/test
# in e2e/package.json, which is checked before anything starts.
#
# A red screenshot is a difference to look at, not a verdict. Open the diff in
# e2e/test-results, then either fix the code or, when the change was meant,
# rerun with --update-snapshots and commit the new baseline on its own, saying
# which decision it records. Never rewrite baselines to make a build green.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT="${STYLEGUIDE_PORT:-3290}"
PLAYWRIGHT_VERSION=1.63.0
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble"

pinned=$(node -p "require('$ROOT_DIR/e2e/package.json').devDependencies['@playwright/test']")
if [ "$pinned" != "$PLAYWRIGHT_VERSION" ]; then
  echo "e2e pins @playwright/test $pinned, this script runs image $PLAYWRIGHT_VERSION. Move both together." >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/apps/web/.next/BUILD_ID" ]; then
  echo "No web build in apps/web/.next. Run 'bash scripts/build.sh' first." >&2
  exit 1
fi

if curl -s -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "Port ${PORT} is already answering. Set STYLEGUIDE_PORT to a free one." >&2
  exit 1
fi

LOG=$(mktemp)
(cd "$ROOT_DIR/apps/web" && exec pnpm exec next start --port "$PORT" --hostname 127.0.0.1) >"$LOG" 2>&1 &
SERVER_PID=$!
# By PID, never by pattern: a pattern matching `next start` also matches the
# live web unit on this host.
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/design-system"; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    cat "$LOG" >&2
    echo "next start exited before it answered." >&2
    exit 1
  fi
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:${PORT}/design-system" || {
  cat "$LOG" >&2
  echo "/design-system did not answer on port ${PORT} within a minute." >&2
  exit 1
}

# The repository is mounted at its own path, so pnpm's symlinks into
# node_modules/.pnpm resolve inside the container exactly as outside. The
# host's user id keeps the written baselines and reports owned by the caller.
docker run --rm --network host --ipc host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e CI="${CI:-}" \
  -e STYLEGUIDE_BASE_URL="http://127.0.0.1:${PORT}" \
  -v "$ROOT_DIR:$ROOT_DIR" \
  -w "$ROOT_DIR/e2e" \
  "$IMAGE" \
  node_modules/.bin/playwright test --config styleguide.config.ts "$@"
