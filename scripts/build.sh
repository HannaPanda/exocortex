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
#   bash scripts/build.sh --full-tests    also the tests that need a database,
#                                         on a throwaway stack of their own,
#                                         and the styleguide gate (Docker)
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
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
run_gate "capability parity"    node scripts/check-capability-parity.mjs
run_gate "feature registry"     node scripts/check-feature-coverage.mjs
run_gate "documentation"        node scripts/check-docs-current.mjs
run_gate "test split"           node scripts/check-test-split.mjs
run_gate "typecheck coverage"   node scripts/check-typecheck-coverage.mjs
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

  # Two linters over the whole repository, in that order. Since issue #84
  # oxlint carries almost all of the policy and walks the tree in a fifth of a
  # second; ESLint is left with the handful of rules oxlint cannot express
  # (`eslint.config.mjs` says which, and why). Both run from the root rather
  # than per package, because the root scripts, the deploy helpers,
  # apps/api/scripts and e2e belong to the size policy too and a per-package
  # `src` run never sees them. Neither is a typecheck, which is what issue #95
  # was: those same files had been outside every tsconfig for as long as they
  # had existed.
  info "oxlint, whole repository …"
  pnpm exec oxlint || fail "oxlint found problems" "Run 'pnpm exec oxlint --fix' for the mechanical ones."

  info "ESLint, the rules oxlint cannot express …"
  pnpm exec eslint . || fail "ESLint found problems" "Run 'pnpm exec eslint . --fix' for the mechanical ones."

  # A soft check and not a hard gate on purpose: an unformatted file is not a
  # wrong file, and stopping a deploy over a line break would be out of
  # proportion. It is only runnable at all since the tree was formatted once in
  # its own commit -- the config had described the repository since the first
  # commit without ever having been applied to it. Keep the fix separate from
  # whatever turned it red: `pnpm format` and its own commit.
  info "Prettier …"
  pnpm format:check >/dev/null || fail "Files are not formatted" \
    "Run 'pnpm format'. If it touches files you did not change, commit that on its own -- a reformat mixed into a real change makes the real change unreadable."

  info "Typecheck …"
  pnpm typecheck || fail "Type errors" "Every TypeScript file in the repository, tests included, is covered by one of these projects; the coverage gate above is what keeps that true."

  # The watchmen. Each gate is run twice, once clean and once with a violation
  # written into the tree, so a gate that has quietly stopped matching anything
  # is caught here rather than by the bug it was supposed to prevent. Fifteen
  # seconds, and it runs wherever this script runs -- here and in CI, which is
  # this script and nothing else.
  info "Gate tests …"
  pnpm test:gates || fail "A gate does not behave the way it is documented to" \
    "Read which case failed: a gate that cannot go red is worse than no gate, because it reports success on a question it no longer asks."

  # The default set is every test that needs no database, no Redis and no
  # object storage -- in every workspace, apps included. Which tests those are
  # is decided by the file name and enforced by the test-split gate above, not
  # by a list of packages here: the list used to name twelve packages and
  # therefore never ran `apps/api`, `apps/web` or `apps/worker` at all, and nine
  # failing tests sat on `master` behind a green build (issue #93).
  #
  # The infrastructure-backed half is one flag away rather than hidden. It is
  # not the default here because it needs Docker and half a minute of container
  # startup, not because it is dangerous any more: since issue #94 it brings up
  # its own Postgres and Redis and cannot reach the deployment's.
  info "Tests without infrastructure (--full-tests adds the rest) …"
  pnpm test:unit || fail "Unit tests failed"

  if [ "$FULL_TESTS" -eq 1 ]; then
    info "Integration tests on a throwaway Postgres and Redis …"
    pnpm test:integration || fail "Integration tests failed"

    # The styleguide gate (issue #127): screenshot baselines, axe and keyboard
    # checks against /design-system, served from the web build step 5 just
    # made on a port of its own, with the browser in the pinned Playwright
    # image. Here rather than in the default set for the same reason as the
    # integration tests: it needs Docker, and two minutes.
    info "Styleguide: screenshots, accessibility, keyboard …"
    pnpm test:styleguide || fail "Styleguide gate failed" \
      "A red screenshot is a difference to review, not a verdict: open the diff in e2e/test-results. Meant? Rerun with 'pnpm test:styleguide:update' and commit the baseline on its own. Not meant? Fix the code. Never rewrite baselines just to get green."
  fi

  ok "Soft checks green."
fi

step "Done"
ok "build.sh green — $(git rev-parse --short HEAD) validated and built. No service was touched."
