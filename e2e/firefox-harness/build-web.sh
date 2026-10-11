#!/usr/bin/env bash
#
# Builds the web app for the harness's own origin (issue #166).
#
#   bash e2e/firefox-harness/build-web.sh <label>
#
# The deployed build cannot be reused: `PUBLIC_API_URL` and
# `PUBLIC_COLLABORATION_URL` are inlined at build time (next.config.ts `env`),
# and the deployed ones name https://exocortex.app. A browser on the harness
# page would talk to production. So the harness builds its own copy into
# `apps/web/.next-harness-<label>`, from the working tree as it is, and
# `run.sh --web <label>` serves it. Building a baseline and a candidate under
# two labels is what makes the comparison in the report possible.
#
# `next build` rewrites `apps/web/next-env.d.ts` to import the types of the
# dist directory it built into. That file is tracked and names `.next`, so it is
# put back afterwards; otherwise every harness build leaves a diff behind.
set -euo pipefail

LABEL="${1:?usage: build-web.sh <label>}"
case "$LABEL" in
  *[!a-z0-9-]*) echo "label must be [a-z0-9-]" >&2; exit 2 ;;
esac

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=ports.sh
source "$ROOT_DIR/e2e/firefox-harness/ports.sh"

cd "$ROOT_DIR/apps/web"
cp next-env.d.ts "$HARNESS_TMP_NEXT_ENV"
trap 'cp "$HARNESS_TMP_NEXT_ENV" next-env.d.ts; rm -f "$HARNESS_TMP_NEXT_ENV"' EXIT

echo "building apps/web into .next-harness-$LABEL for $HARNESS_ORIGIN (commit $(git rev-parse --short HEAD), dirty files: $(git status --porcelain | wc -l))"
# Through pnpm, not node directly: pnpm puts its hoisted store on NODE_PATH,
# and that is where `@import 'tailwindcss'` in packages/ui/src resolves from.
# Without it the build fails in the PostCSS step.
NODE_ENV=production \
EXOCORTEX_WEB_DIST_DIR=".next-harness-$LABEL" \
PUBLIC_API_URL="$HARNESS_ORIGIN" \
PUBLIC_COLLABORATION_URL="ws://$HARNESS_HOST:$HARNESS_PROXY_PORT/collab" \
APP_URL="$HARNESS_ORIGIN" \
  pnpm exec next build

git -C "$ROOT_DIR" rev-parse HEAD > ".next-harness-$LABEL/HARNESS_COMMIT"
git -C "$ROOT_DIR" diff HEAD -- apps/web packages > ".next-harness-$LABEL/HARNESS_DIFF.patch" || true
echo "done: apps/web/.next-harness-$LABEL"
