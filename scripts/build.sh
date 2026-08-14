#!/usr/bin/env bash
#
# Validate and build. Starts nothing, restarts nothing, touches no live service.
#
# This is the answer to "is this commit healthy", and it is the whole of
# `deploy.sh`'s first half: deploy.sh calls this script and only then goes near
# systemd. Keeping the two apart means the question can be asked at any time,
# including on a machine that is not serving anything.
#
#   bash scripts/build.sh                 validate and build
#   bash scripts/build.sh --skip-checks   hard gates only, no lint/typecheck/tests
#   bash scripts/build.sh --full-tests    also the tests that need the database
#
# Two kinds of check, and the difference matters:
#
#   * hard gates are correctness and always run. `--skip-checks` does not reach
#     them, and they have no flag of their own. Each one exists because
#     something can be wrong in a way nothing else in the repository notices.
#   * soft checks are lint, typecheck, formatting and tests. `--skip-checks`
#     skips them, for the rare hour when something has to go out and the
#     failure is understood.
#
# On this host the build is sequential on purpose. The four units keep serving
# while it runs, there are 16 GB shared with everything else on the machine, and
# the Next.js build on its own is enough to summon the OOM killer. See
# `deploy/README.md`.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

SKIP_CHECKS=0
FULL_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=1 ;;
    --full-tests)  FULL_TESTS=1 ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (allowed: --skip-checks, --full-tests, --help)" >&2
      exit 2
      ;;
  esac
done

GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; CYAN='\033[36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
step() { printf '\n%b▸%b %b%s%b\n' "$CYAN" "$NC" "$BOLD" "$1" "$NC"; }
ok()   { printf '%b✓%b %s\n' "$GREEN" "$NC" "$1"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$NC" "$1" >&2; }
info() { printf '  %b%s%b\n' "$DIM" "$1" "$NC"; }
fail() {
  printf '%b✗%b %b%s%b\n' "$RED" "$NC" "$BOLD" "$1" "$NC" >&2
  [ -n "${2:-}" ] && printf '  %b→%b %s\n' "$YELLOW" "$NC" "$2" >&2
  exit 1
}

# A hard gate prints its own findings and its own hint; all this adds is that
# the build stopped and that there is no way around it.
run_gate() {
  local label="$1"; shift
  if ! "$@"; then
    fail "Gate red: $label" "Hard gate, no bypass. Fix the cause reported above."
  fi
}

# --- 0. Working tree ---------------------------------------------------------
# Before anything else, and not covered by --skip-checks. Everything downstream
# assumes "what is deployed is a git SHA": the build marker, the deploy marker
# and deploy.sh's change detection all compare commits. An uncommitted file
# breaks that assumption silently, because it changes what gets built without
# changing what the markers record.
step "Step 0 — working tree"
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  printf '%s\n' "$DIRTY" | sed 's/^/    /' >&2
  fail "Working tree not clean" \
       "Commit or ignore the files above. A build is identified by its commit, and these are not in one."
fi
HEAD_SHA="$(git rev-parse HEAD)"
ok "Clean at $(git rev-parse --short HEAD)."

# --- 1. Headroom -------------------------------------------------------------
step "Step 1 — memory headroom"
AVAILABLE_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
info "${AVAILABLE_MB} MB available"
if [ "$AVAILABLE_MB" -lt 1024 ]; then
  fail "Only ${AVAILABLE_MB} MB available" \
       "The Next.js build needs more than this and the OOM killer does not choose its victim carefully -- it may take a live unit instead. Find out what is using the memory first."
fi
if [ "$AVAILABLE_MB" -lt 2048 ]; then
  warn "Under 2 GB available. The build will work but has little room; watch 'dmesg | tail' if a step is killed."
fi
ok "Enough headroom."

# --- 2. Dependencies ---------------------------------------------------------
step "Step 2 — pnpm install --frozen-lockfile"
if ! pnpm install --frozen-lockfile; then
  fail "Install failed" \
       "If the lockfile is out of date, run 'pnpm install' by hand and commit the result: a build must install exactly what the commit records."
fi
ok "Dependencies installed."

# --- 3. Prisma client --------------------------------------------------------
# Before the gates and the build: the generated client is an import target for
# half the repository, and a stale one produces type errors that look like real
# ones.
step "Step 3 — Prisma client"
pnpm db:generate >/dev/null
ok "Prisma client generated."

# --- 4. Hard gates -----------------------------------------------------------
step "Step 4 — hard gates (always on, no bypass)"
run_gate "package boundaries"   node scripts/check-dependency-boundaries.mjs
run_gate "configuration sync"   node scripts/check-env-example.mjs
run_gate "brand spelling"       node scripts/check-brand-spelling.mjs
run_gate "MCP catalogue"        node scripts/check-mcp-catalog.mjs
run_gate "migration history"    bash scripts/check-migrations-reproducible.sh
ok "All hard gates green."

# --- 5. Build ----------------------------------------------------------------
# One package at a time, in dependency order, web last. The marker records which
# commit the artefacts in dist/ and .next/ belong to, and nothing else: it is
# not a claim that the checks passed.
step "Step 5 — build (sequential, web last)"
MARKER="$ROOT_DIR/.build-marker"
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$HEAD_SHA" ]; then
  ok "Artefacts already match $(git rev-parse --short HEAD) — build skipped."
else
  while read -r package; do
    info "$package"
    if ! pnpm --filter "$package" build; then
      fail "Build failed: $package" \
           "If it was killed rather than failing, it is the OOM killer: check 'dmesg | tail' and free memory before retrying. Do not retry in a loop."
    fi
  done < <(node scripts/lib/build-order.mjs)
  printf '%s' "$HEAD_SHA" > "$MARKER"
  ok "Build complete."
fi

# --- 6. Soft checks ----------------------------------------------------------
if [ "$SKIP_CHECKS" -eq 1 ]; then
  step "Step 6 — soft checks SKIPPED (--skip-checks)"
  warn "Lint, typecheck, formatting and tests did not run. Meant for the rare hour when the failure is already understood."
else
  step "Step 6 — soft checks"

  # `eslint .` rather than `pnpm lint`: each package lints `src` only, so the
  # root scripts, the deploy helpers, apps/api/scripts and e2e are never seen by
  # the per-package runs. The size policy from issue #40 applies to those too.
  info "ESLint, whole repository …"
  pnpm exec eslint . || fail "ESLint found problems" "Run 'pnpm exec eslint . --fix' for the mechanical ones."

  # `pnpm format:check` is deliberately NOT here. Prettier disagrees with 314 of
  # the repository's files today -- it has never been run over the whole tree --
  # so switching it on as a gate means one commit that rewrites nearly every
  # file and rewrites the blame with it. That is a decision worth making on its
  # own, not a side effect of introducing a build script. Until then the check
  # exists as `pnpm format:check` and says something true about the repository;
  # it just does not stop a deploy.

  info "Typecheck …"
  pnpm typecheck || fail "Type errors" "Note that apps/api/scripts is outside apps/api/tsconfig.json and is only reached by the ESLint step above."

  if [ "$FULL_TESTS" -eq 1 ]; then
    warn "--full-tests: the integration tests talk to the PRODUCTION database and Redis on this host."
    warn "They create throwaway rows and clean up after themselves, but they are not isolated."
    pnpm test || fail "Tests failed"
  else
    # The default set is everything that needs no database, no Redis and no
    # object storage. Without a CI this is the only place tests run at all, so
    # the DB-backed half is one flag away rather than hidden -- but it is not
    # the default, because pointing a test suite at the live database on the way
    # to deploying is a bad reflex to build.
    info "Tests without infrastructure (--full-tests adds the rest) …"
    pnpm --filter @exocortex/contracts --filter @exocortex/config --filter @exocortex/logger \
         --filter @exocortex/editor --filter @exocortex/ui --filter @exocortex/storage \
         --filter @exocortex/ai --filter @exocortex/calendar --filter @exocortex/auth \
         --filter @exocortex/mcp-tools --filter @exocortex/mcp test \
      || fail "Tests failed"
  fi

  ok "Soft checks green."
fi

step "Done"
ok "build.sh green — $(git rev-parse --short HEAD) validated and built. No service was touched."
