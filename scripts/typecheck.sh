#!/usr/bin/env bash
#
# `pnpm typecheck`: every TypeScript project in the repository, inside a
# memory limit (issue #325).
#
#   pnpm typecheck                           every workspace, then the tooling project
#   pnpm typecheck --filter=@exocortex/web   one workspace (any turbo argument)
#
# Three things on top of `turbo run typecheck`, in this order:
#
#   1. `scripts/check-i18n-keys.mjs` first. A namespace or key the German
#      catalogue lacks is a second's work for it and gigabytes for tsc, which
#      explains the error against the whole catalogue (5 GB on 2026-11-27).
#   2. turbo at a concurrency of four unless the caller names one: measured
#      uncached, four tsc at a time peak at 2.7 GB in 31 s, turbo's default of
#      ten at 4.1 GB in 29 s. Same time, a third less memory.
#   3. all of it inside `scripts/memory-scope.sh typecheck`, so a tsc that runs
#      away anyway ends at EXOCORTEX_TYPECHECK_MEMORY_MAX (default 4G) with a
#      message that says so, instead of starving the live units.
#
# The tooling project (`tsconfig.tools.json`: vitest configs, the Next config,
# the gate suite) belongs to no workspace, so it runs only when no turbo
# argument narrowed the run.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

node scripts/check-i18n-keys.mjs

TURBO_ARGS=("$@")
EXPLICIT_CONCURRENCY=0
for arg in "$@"; do
  case "$arg" in --concurrency*) EXPLICIT_CONCURRENCY=1 ;; esac
done
[ "$EXPLICIT_CONCURRENCY" -eq 1 ] || TURBO_ARGS+=(--concurrency=4)

bash scripts/memory-scope.sh typecheck "Typecheck" -- \
  pnpm exec turbo run typecheck "${TURBO_ARGS[@]}"

if [ $# -eq 0 ]; then
  bash scripts/memory-scope.sh typecheck "Typecheck (tooling project)" -- \
    pnpm exec tsc -p tsconfig.tools.json --noEmit
fi
