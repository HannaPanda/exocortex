#!/usr/bin/env bash
#
# Run the integration tests against infrastructure that exists only while they
# run (issue #94).
#
#   bash scripts/test-integration.sh                    every integration suite
#   bash scripts/test-integration.sh @exocortex/api     one workspace only
#   bash scripts/test-integration.sh --keep             leave the stack up afterwards
#   bash scripts/test-integration.sh --run '<command>'  that command instead
#
# A bare argument is a workspace name and is handed to turbo as `--filter`. It
# is deliberately not a test-name filter: vitest ORs its positional arguments
# together, so a second one would widen the selection rather than narrow it.
#
# `--run` is for the one caller that needs a database but is not a test run:
# `deploy.sh` step 5b compiles the API's module graph before restarting
# anything, which opens a connection because Better Auth seeds its OAuth
# resource rows as the module initialises. That used to happen against the
# live database on every deploy.
#
# Until this script existed, `pnpm test:integration` on this host opened the
# live database and the live Redis, because that is what the repository's `.env`
# points at. The suites were careful -- reserved `@exocortex.test` accounts, an
# age limit, their own cleanup -- but careful is not the same as unable, and an
# interrupted run, a mis-selected cleanup or a new suite with a side effect
# nobody thought about were all one mistake away from production data.
#
# So the tests get their own Postgres and their own Redis, both empty, both
# gone afterwards, and a guard (`vitest.setup.integration.ts`) refuses to let a
# suite run against anything else. The URLs exported below are what that guard
# compares against; `loadDotEnv` never overwrites a variable that is already
# set, which is what makes them win over the repository's `.env`.
#
# ## On cleaning up
#
# Three separate mechanisms, because the interesting case is the run that is
# killed rather than the one that finishes:
#
#   1. the stack is torn down *before* it is brought up. A previous run that
#      died between `up` and its trap left containers behind; this converges
#      regardless, and it is the only one of the three that helps after a
#      reboot or a `kill -9`.
#   2. a trap on EXIT, INT and TERM, which covers Ctrl-C and an ordinary failure.
#   3. `down` always passes `-v`, and both data directories are tmpfs anyway.
#      `pgvector/pgvector:pg17` and `redis:8-alpine` declare a VOLUME, and a
#      container removed without `-v` leaves an anonymous volume behind: 919 of
#      them, 46.7 GB, had accumulated from the migration gate by 2026-09-19.
#      The tmpfs mounts mean none is created in the first place; the `-v` is the
#      second line of defence for the day somebody adds a service without one.
#
# The dangling-volume count is compared across the run and reported, so the day
# that stops being true it is visible here rather than on a full disk.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yml"
PROJECT="exocortex-test"

# Two above the deployment's own ports (5433 / 6380), so that a URL pointing at
# the wrong stack is visible rather than plausible.
PG_PORT="${EXOCORTEX_TEST_POSTGRES_PORT:-5435}"
REDIS_PORT="${EXOCORTEX_TEST_REDIS_PORT:-6382}"
export EXOCORTEX_TEST_POSTGRES_PORT="$PG_PORT"
export EXOCORTEX_TEST_REDIS_PORT="$REDIS_PORT"

KEEP=0
RUN_COMMAND=""
FILTER=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --run)
      shift
      [ $# -gt 0 ] || { echo "--run needs a command" >&2; exit 2; }
      RUN_COMMAND="$1"
      ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "Unknown argument: $1 (allowed: --keep, --run, --help, or a workspace name)" >&2
      exit 2
      ;;
    *) FILTER+=("$1") ;;
  esac
  shift
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

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# `--remove-orphans` as well as `-v`: a service removed from the compose file
# would otherwise keep running under this project name forever, which is the
# definition of an orphan.
teardown() {
  compose down -v --remove-orphans --timeout 10 >/dev/null 2>&1 || true
}

command -v docker >/dev/null 2>&1 || fail "Docker is required but was not found."
docker info >/dev/null 2>&1 || fail "Docker is installed but not usable (daemon down, or no permission)."

DANGLING_BEFORE=$(docker volume ls -qf dangling=true | wc -l)

# --- 1. A clean slate -------------------------------------------------------
step "Step 1 — removing anything a previous run left behind"
teardown
ok "No $PROJECT containers."

if [ "$KEEP" -eq 0 ]; then
  trap teardown EXIT INT TERM
else
  trap 'warn "--keep: the test stack is still running. Remove it with: docker compose -p '"$PROJECT"' -f docker-compose.test.yml down -v"' EXIT
fi

# --- 2. The throwaway stack -------------------------------------------------
step "Step 2 — starting Postgres and Redis (tmpfs, no volumes, no restart)"
if ! compose up -d --wait; then
  compose logs --tail 30 >&2 || true
  fail "The test stack did not become healthy." \
       "The logs above are from the containers themselves. A port clash on $PG_PORT or $REDIS_PORT is the usual cause -- set EXOCORTEX_TEST_POSTGRES_PORT / EXOCORTEX_TEST_REDIS_PORT."
fi
ok "Postgres on 127.0.0.1:$PG_PORT, Redis on 127.0.0.1:$REDIS_PORT."

# Exported before the migration so Prisma uses them too: `prisma.config.ts`
# loads the repository's `.env` without overriding, so whatever is already in
# the environment wins.
export DATABASE_URL="postgresql://exocortex_test:exocortex_test@127.0.0.1:${PG_PORT}/exocortex_test?schema=public"
export REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
export EXOCORTEX_TEST_DATABASE_URL="$DATABASE_URL"
export EXOCORTEX_TEST_REDIS_URL="$REDIS_URL"
export EXOCORTEX_TEST_INFRA=1

# --- 3. Schema --------------------------------------------------------------
# `migrate deploy`, never `migrate dev`: the latter wants to drop the search
# index every time it runs on this schema, and it would do so here against a
# database that is about to be asserted on.
step "Step 3 — applying the migration history to the empty database"
if ! pnpm --filter @exocortex/database db:migrate; then
  fail "Migrations failed against the throwaway database." \
       "If they replay on the migration gate but not here, the difference is that this database is also asserted on afterwards -- read the error rather than retrying."
fi
ok "Schema applied."

# --- 3b. Reference data -----------------------------------------------------
# The AI model registry, and deliberately nothing else. It is reference data,
# not somebody's content: a table of slugs, context windows and prices that
# every deployment has after `db:seed:ai-models`, upserted by slug and reaching
# no network. `ConversationsService` picks a model out of it before a single
# assertion runs, so without this the suite fails on an empty table rather than
# on anything it means to test.
#
# `db:seed` proper is NOT run. It creates Johanna's and Stefan's accounts from
# the seed passwords, and a test that found a user it did not create is a test
# that would pass for the wrong reason. Every suite makes its own.
step "Step 3b — seeding the AI model registry"
if ! pnpm --filter @exocortex/database db:seed:ai-models >/dev/null; then
  fail "Could not seed the AI model registry."
fi
ok "Model registry seeded."

# --- 4. The suites ----------------------------------------------------------
set +e
if [ -n "$RUN_COMMAND" ]; then
  step "Step 4 — the given command, against the throwaway stack"
  info "$RUN_COMMAND"
  bash -c "$RUN_COMMAND"
else
  step "Step 4 — integration tests"
  TURBO_ARGS=(run test:integration)
  for workspace in ${FILTER[@]+"${FILTER[@]}"}; do
    info "workspace: $workspace"
    TURBO_ARGS+=(--filter "$workspace")
  done
  pnpm exec turbo "${TURBO_ARGS[@]}"
fi
TEST_STATUS=$?
set -e

# --- 5. What is left --------------------------------------------------------
# The teardown itself happens in the trap. This only reports, because a leak
# that nobody counts is the one that reaches 919.
if [ "$KEEP" -eq 0 ]; then
  teardown
  trap - EXIT INT TERM
  DANGLING_AFTER=$(docker volume ls -qf dangling=true | wc -l)
  if [ "$DANGLING_AFTER" -gt "$DANGLING_BEFORE" ]; then
    warn "This run left $((DANGLING_AFTER - DANGLING_BEFORE)) dangling Docker volume(s) behind."
    warn "That should be impossible with the tmpfs mounts -- check docker-compose.test.yml for a service that lost one, then 'docker volume prune -f'."
  fi
fi

if [ "$TEST_STATUS" -ne 0 ]; then
  if [ -n "$RUN_COMMAND" ]; then
    fail "The command failed." "It ran against the throwaway stack, which has been removed; re-run with --keep to inspect the database afterwards."
  fi
  fail "Integration tests failed." "The stack they ran against has been removed; re-run with --keep to inspect the database afterwards."
fi

step "Done"
if [ -n "$RUN_COMMAND" ]; then
  ok "The command succeeded. The stack it ran against no longer exists."
else
  ok "Integration tests green. The stack they ran against no longer exists."
fi
