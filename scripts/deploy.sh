#!/usr/bin/env bash
#
# Roll the current commit out onto this host.
#
#   bash scripts/deploy.sh                 the whole way
#   bash scripts/deploy.sh --skip-checks   passed to build.sh (hard gates still run)
#   bash scripts/deploy.sh --full-tests    passed to build.sh (touches the live database)
#   bash scripts/deploy.sh --dry-run       everything up to the first change, then stop
#
# `build.sh` answers "is this commit healthy" and starts nothing. This script
# calls it and then does the parts that touch the running system: migrations,
# the model registry, nginx, the four units, and the readiness check afterwards.
# Everything below the build is here and nothing above it is, so the question
# and the act stay separable.
#
# No `git pull`. Development and deployment happen on this same host, so there
# is nothing to fetch: the script rolls out the local HEAD and only checks that
# it is not something origin has never seen.
#
# What it refuses to do: deploy a dirty tree, deploy past a red gate, or write
# the deploy marker after a rollout that did not come back healthy.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

BUILD_ARGS=()
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-checks|--full-tests) BUILD_ARGS+=("$arg") ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (allowed: --skip-checks, --full-tests, --dry-run, --help)" >&2
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

MARKER="$ROOT_DIR/.last-deployed-sha"
UNITS=(exocortex-api exocortex-collaboration exocortex-worker exocortex-web)
HEALTH_URL="http://127.0.0.1:3211/health/ready"

printf '%beXocortex deploy%b — started %s\n' "$BOLD" "$NC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- 1. Where we are ---------------------------------------------------------
step "Step 1 — the commit being rolled out"
HEAD_SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
info "HEAD $SHORT — $(git log -1 --format=%s)"

# Being ahead of origin is not fatal but is worth saying out loud: this
# repository's rule is that a commit is pushed as soon as it is made, so an
# unpushed commit going live means the only copy of it is on this disk.
if git remote get-url origin >/dev/null 2>&1; then
  if git fetch --quiet origin master 2>/dev/null; then
    AHEAD=$(git rev-list --count origin/master..HEAD)
    BEHIND=$(git rev-list --count HEAD..origin/master)
    if [ "$BEHIND" -gt 0 ]; then
      fail "origin/master has $BEHIND commit(s) this checkout does not" \
           "Someone else pushed, or this checkout was reset. Reconcile before rolling out -- deploying now would take those commits back off the deployment."
    fi
    [ "$AHEAD" -gt 0 ] && warn "$AHEAD commit(s) not pushed yet. They will go live from this disk only."
    ok "In sync with origin/master."
  else
    warn "Could not reach origin. Rolling out the local HEAD without checking it against the remote."
  fi
fi

if [ -f "$MARKER" ]; then
  PREVIOUS="$(tr -d '[:space:]' < "$MARKER")"
  if git cat-file -e "${PREVIOUS}^{commit}" 2>/dev/null; then
    if [ "$PREVIOUS" = "$HEAD_SHA" ]; then
      info "Already the deployed commit. Continuing anyway -- a re-run is how a half-finished deploy is finished."
    else
      info "Live now: ${PREVIOUS:0:8} ($(git rev-list --count "$PREVIOUS..HEAD") commit(s) behind HEAD)"
    fi
  else
    PREVIOUS=""
    warn "The deploy marker names a commit this repository does not have. Treating everything as changed."
  fi
else
  PREVIOUS=""
  warn "No deploy marker yet. Treating everything as changed."
fi

# Did `path` change since the deployed commit? Unknown history answers yes: the
# expensive branch is the safe one for every caller below.
changed_since_deploy() {
  [ -z "$PREVIOUS" ] && return 0
  ! git diff --quiet "$PREVIOUS" HEAD -- "$1"
}

# --- 2. Validate and build ---------------------------------------------------
step "Step 2 — build.sh"
info "Working tree, headroom, install, Prisma client, hard gates, build, soft checks"
bash scripts/build.sh ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} || fail "build.sh is red — nothing was touched" \
  "The output above says which step. No service has been restarted and no migration has run."
ok "Commit validated and built."

if [ "$DRY_RUN" -eq 1 ]; then
  step "Dry run"
  ok "Stopping here. Everything from this point changes the running system."
  exit 0
fi

# --- 3. Migrations -----------------------------------------------------------
# `migrate status` first, so what is about to be applied is on screen before it
# is applied. Never `migrate dev` against this database: it offers a reset when
# it sees drift, and the drift it sees here is the search index it cannot model.
step "Step 3 — database migrations"
if ! pnpm --filter @exocortex/database exec prisma migrate status; then
  info 'migrate status exits non-zero whenever migrations are pending, which is the normal case here.'
fi
pnpm db:migrate || fail "Migration failed" \
  "The old code is still running and still serving. Read the error before restarting anything."
ok "Database migrated."

# --- 4. Model registry -------------------------------------------------------
# Idempotent (upsert by slug, re-wires the vision companions), but it is a write
# against the live database, so it only runs when its own seed changed.
step "Step 4 — model registry"
if changed_since_deploy 'packages/database/prisma/seed-ai-models.ts'; then
  pnpm --filter @exocortex/database db:seed:ai-models \
    || fail "Seeding the model registry failed"
  ok "Model registry seeded."
else
  info "seed-ai-models.ts unchanged — skipped."
fi

# --- 5. nginx ----------------------------------------------------------------
step "Step 5 — nginx"
NGINX_SRC="deploy/nginx/exocortex.app.conf"
NGINX_DST="/etc/nginx/sites-available/exocortex"
if changed_since_deploy "$NGINX_SRC" || ! sudo diff -q "$NGINX_SRC" "$NGINX_DST" >/dev/null 2>&1; then
  # `nginx -t` can only test what is installed, so the new file has to go in
  # before it can be judged. The backup is what makes that safe: a rejected
  # configuration is put back immediately, because otherwise sites-available
  # would hold a broken file that the next reload -- for any reason, days later
  # -- would trip over.
  BACKUP=$(mktemp)
  sudo cp "$NGINX_DST" "$BACKUP" 2>/dev/null || true
  sudo cp "$NGINX_SRC" "$NGINX_DST"
  if ! sudo nginx -t; then
    sudo cp "$BACKUP" "$NGINX_DST"
    rm -f "$BACKUP"
    fail "nginx rejected the configuration" \
      "The previously installed file has been put back and nginx was never reloaded, so the site is still up on the old configuration. Fix $NGINX_SRC and re-run."
  fi
  rm -f "$BACKUP"
  sudo systemctl reload nginx
  ok "nginx configuration installed and reloaded."
else
  info "Configuration unchanged and identical to the installed one — skipped."
fi

# --- 6. Restart --------------------------------------------------------------
# API first, because everything talks to it; web last, because it is what people
# have open. SIGTERM is a graceful shutdown everywhere (in-flight jobs finish,
# pending document stores are flushed) and every process reconnects, so the
# order is about shrinking the window in which a request meets a stale peer, not
# about correctness.
#
# Never `pkill -f`: a pattern like "node dist/main.js" matches the live services.
step "Step 6 — restart the four units"
for unit in "${UNITS[@]}"; do
  info "$unit"
  sudo systemctl restart "$unit" || fail "$unit did not restart" \
    "Check: journalctl -u $unit -n 50 --no-pager"
done
ok "All four restarted."

# --- 7. Readiness ------------------------------------------------------------
# Retried, because the API needs a moment and a single early probe would report
# a healthy deploy as broken. Reported per dependency: database, Redis, storage.
step "Step 7 — readiness"
READY=0
for attempt in $(seq 1 15); do
  BODY=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)
  if [ -n "$BODY" ] && [[ "$BODY" == *'"status":"ok"'* ]]; then
    info "$BODY"
    READY=1
    break
  fi
  [ "$attempt" -eq 1 ] || info "attempt $attempt/15 …"
  sleep 2
done
[ "$READY" -eq 1 ] || fail "The deployment did not become ready within 30 seconds" \
  "Last answer: ${BODY:-<none>}. Look at 'journalctl -u exocortex-api -n 50 --no-pager'. The marker was NOT written, so a re-run will do the whole thing again."

for unit in "${UNITS[@]}"; do
  state=$(systemctl is-active "$unit" || true)
  [ "$state" = "active" ] || fail "$unit is $state" "Check: journalctl -u $unit -n 50 --no-pager"
done
ok "Ready, and all four units active."

# --- 8. Marker ---------------------------------------------------------------
# Last, and only here. A deploy that fell over halfway leaves no green marker
# behind, so the next run re-does everything rather than believing this one.
printf '%s' "$HEAD_SHA" > "$MARKER"

step "Done"
ok "$SHORT is live. Finished $(date -u +%Y-%m-%dT%H:%M:%SZ)."
# Expected, and not a failure: restarting the worker is where `reap-stale-ai-runs`
# meets whatever the previous deploy left mid-flight, so a burst of
# `ai_run_abandoned` in the journal right now is the reaper doing its job.
info "A burst of ai_run_abandoned in the worker journal in the next minute is expected: the reaper is closing out runs the old process left behind."
