#!/usr/bin/env bash
#
# Run one heavy step inside a memory limit of its own (issue #325).
#
#   bash scripts/memory-scope.sh <budget> <label> -- <command> [args...]
#   bash scripts/memory-scope.sh --status       one line: which limits apply here
#
# The budgets, each a systemd size (4G, 3500M) or `off`:
#
#   typecheck   EXOCORTEX_TYPECHECK_MEMORY_MAX, default 4G
#               `pnpm typecheck`, which runs turbo at a concurrency of four:
#               measured at 2.7 GB on 2026-11-28, uncached (4.1 GB at turbo's
#               default of ten, for the same 30 seconds).
#   build       EXOCORTEX_BUILD_MEMORY_MAX, default 5G
#               every other heavy step of build.sh: each package's build,
#               oxlint, ESLint, the gate tests and the test suites. The largest
#               measured: oxlint 3.0 GB, a cold `next build` 2.8 GB, the gate
#               tests 2.7 GB.
#
# Why at all: on 2026-11-27 one `useTranslations` with a namespace the German
# catalogue lacked took tsc past 5 GB, and the host -- 16 GB, shared with the
# live units -- was held for most of an hour. A missing key is an ordinary
# mistake; it should fail one step, not starve the machine. The limit is a
# cgroup of the step's own (`systemd-run --user --scope`), so the kernel ends
# the largest process inside it and nothing outside: no live unit, no other
# session. `MemorySwapMax=0` because a step pushed into swap thrashes the whole
# host instead of failing, and `OOMPolicy=continue` because systemd would
# otherwise stop the scope, this script included, before it could say why.
#
# Where `systemd-run --user` cannot create a scope (a CI runner, a container,
# a host without a user session) the command runs without a limit, exactly as
# before. The exit status is always the command's own, except 137 when the
# limit ended it.

set -uo pipefail

SELF="${BASH_SOURCE[0]}"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  RED='\033[31m'; YELLOW='\033[33m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  RED=''; YELLOW=''; BOLD=''; DIM=''; NC=''
fi

budget_variable() {
  case "$1" in
    typecheck) echo EXOCORTEX_TYPECHECK_MEMORY_MAX ;;
    build) echo EXOCORTEX_BUILD_MEMORY_MAX ;;
    *) return 1 ;;
  esac
}

budget_default() {
  case "$1" in
    typecheck) echo 4G ;;
    build) echo 5G ;;
  esac
}

# The limit a budget resolves to, validated: a size systemd accepts, or `off`.
budget_limit() {
  local variable value
  variable=$(budget_variable "$1")
  value="${!variable:-$(budget_default "$1")}"
  if [ "$value" != off ] && ! [[ "$value" =~ ^[0-9]+(\.[0-9]+)?[KMGT]?$ ]]; then
    printf '%s must be a size like 4G or 3500M, or "off" -- not "%s".\n' "$variable" "$value" >&2
    return 2
  fi
  echo "$value"
}

# Whether this machine can put a command into a user scope with a memory limit.
# Asked with a real scope rather than by looking for the binary: a runner can
# have systemd-run and no user session to talk to.
scopes_available() {
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemd-run --user --scope --quiet --collect -p MemoryMax=64M -p MemorySwapMax=0 \
    -p OOMPolicy=continue -- true >/dev/null 2>&1
}

# --- inside the scope ---------------------------------------------------------
# Runs the command, then asks the scope's own cgroup whether the kernel ended
# anything for want of memory. The exit status alone cannot say: a process
# killed three levels down (pnpm, turbo, tsc) reaches this script as whatever
# its parents made of it.
if [ "${1:-}" = --inside ]; then
  variable="$2"; limit="$3"; label="$4"; shift 5
  cgroup="/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)"
  "$@"
  status=$?
  kills=$(awk '$1 == "oom_kill" { print $2 }' "$cgroup/memory.events" 2>/dev/null)
  if [ "${kills:-0}" -gt 0 ]; then
    {
      printf '%b✗%b %b%s stopped at its memory limit of %s (%s)%b\n' "$RED" "$NC" "$BOLD" "$label" "$limit" "$variable" "$NC"
      printf '  The kernel ended the largest process inside this step'"'"'s own scope. Nothing outside it was touched, the live units included.\n'
      printf '  %b→%b Most common cause: a namespace or key the German catalogue lacks. tsc then checks every t() against the\n' "$YELLOW" "$NC"
      printf '    whole catalogue and grows past any limit. `node scripts/check-i18n-keys.mjs` names the literal ones with file and\n'
      printf '    line; a key built at run time (t(`errors.${code}`) with code: string) it cannot see. A stale dist of\n'
      printf '    @exocortex/i18n does the same: `pnpm --filter @exocortex/i18n build`.\n'
      printf '  %b→%b Only if the step really needs more: %s=<size> (or off) in front of the command, e.g.\n' "$YELLOW" "$NC" "$variable"
      if [ "$variable" = EXOCORTEX_TYPECHECK_MEMORY_MAX ]; then
        printf '    %s=6G pnpm typecheck, or the same in front of bash scripts/build.sh\n' "$variable"
      else
        printf '    %s=8G bash scripts/build.sh\n' "$variable"
      fi
    } >&2
    exit 137
  fi
  exit "$status"
fi

# --- status -------------------------------------------------------------------
if [ "${1:-}" = --status ]; then
  typecheck=$(budget_limit typecheck) || exit 2
  build=$(budget_limit build) || exit 2
  if scopes_available; then
    printf 'Memory limits: typecheck %s (EXOCORTEX_TYPECHECK_MEMORY_MAX), other heavy steps %s (EXOCORTEX_BUILD_MEMORY_MAX).\n' "$typecheck" "$build"
  else
    printf 'No systemd user session here: heavy steps run without a memory limit.\n'
  fi
  exit 0
fi

# --- outside: choose the limit and enter the scope ---------------------------
if [ $# -lt 4 ] || [ "$3" != -- ]; then
  echo "Usage: bash scripts/memory-scope.sh <typecheck|build> <label> -- <command> [args...]" >&2
  exit 2
fi
budget="$1"; label="$2"; shift 3
variable=$(budget_variable "$budget") || {
  echo "Unknown budget: $budget (allowed: typecheck, build)" >&2
  exit 2
}
limit=$(budget_limit "$budget") || exit 2

if [ "$limit" = off ] || ! scopes_available; then
  exec "$@"
fi

[ -t 2 ] && printf '  %b%s: memory limit %s%b\n' "$DIM" "$label" "$limit" "$NC" >&2
exec systemd-run --user --scope --quiet --collect \
  -p MemoryMax="$limit" -p MemorySwapMax=0 -p OOMPolicy=continue \
  -- bash "$SELF" --inside "$variable" "$limit" "$label" -- "$@"
