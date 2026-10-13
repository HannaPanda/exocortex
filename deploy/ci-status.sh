#!/usr/bin/env bash
#
# What did the CI last say about master? (issue #192)
#
#   bash deploy/ci-status.sh           print the verdict; exit 0 green, 1 red, 2 unknown
#   bash deploy/ci-status.sh --alert   the same, and tell Johanna over Telegram
#                                      when the verdict changed since the last call
#
# The CI runs `build.sh --full-tests`, the deploy runs `build.sh` without it, so
# the integration tests and the styleguide gate are only ever judged on GitHub.
# For three weeks nobody looked there and master stayed red. This script is the
# one place that asks: `deploy.sh` calls it and warns, and
# `exocortex-ci-watch.timer` calls it with `--alert` so a red build is heard
# about without anybody deploying.
#
# Only a finished run counts. A cancelled one says nothing (the workflow cancels
# a run when the next push arrives), and one still running is not a verdict yet.
#
# `--alert` remembers the last run it judged in a state file outside the
# repository and speaks only on a change: red once per newly red run, green once
# when master recovers. It never fails because the alarm failed, for the same
# reason as `backup-alert.sh`.

set -uo pipefail

WORKFLOW="build.yml"
BRANCH="master"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/exocortex"
STATE_FILE="$STATE_DIR/ci-watch.last"

ALERT=0
case "${1:-}" in
  --alert) ALERT=1 ;;
  "") ;;
  *) echo "Unknown argument: $1 (allowed: --alert)" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 2

# Newest run that reached a verdict: tab-separated id, conclusion, sha, url, title.
latest="$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --status completed --limit 20 \
  --json databaseId,conclusion,headSha,url,displayTitle \
  --jq '[.[] | select(.conclusion == "success" or .conclusion == "failure")][0]
        | select(. != null)
        | [.databaseId, .conclusion, .headSha[:8], .url, .displayTitle] | @tsv' 2>&1)" || {
  echo "Could not ask GitHub for the CI result: $latest"
  exit 2
}
if [ -z "$latest" ]; then
  echo "No finished CI run on $BRANCH yet."
  exit 2
fi

IFS=$'\t' read -r run_id conclusion sha url title <<< "$latest"

# The lines build.sh marks as failed (`✗ …`), stripped of the runner's
# timestamps and colour codes. That is the reason, not just the job's name.
failures=""
if [ "$conclusion" = "failure" ]; then
  failures="$(gh run view "$run_id" --log-failed 2>/dev/null \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -E '✗' \
    | sed -E 's/^.*Z (✗ )?//' \
    | head -n 5)"
  [ -n "$failures" ] || failures="(no ✗ line in the log; open the run)"
fi

if [ "$conclusion" = "success" ]; then
  echo "CI on $BRANCH is green: $sha $title"
  echo "$url"
  verdict=0
else
  echo "CI on $BRANCH is red: $sha $title"
  printf '%s\n' "$failures" | sed 's/^/  /'
  echo "$url"
  verdict=1
fi

[ "$ALERT" -eq 1 ] || exit "$verdict"

mkdir -p "$STATE_DIR"
previous="$(cat "$STATE_FILE" 2>/dev/null || true)"
previous_id="${previous%% *}"
previous_conclusion="${previous#* }"
printf '%s %s\n' "$run_id" "$conclusion" > "$STATE_FILE"

if [ "$previous_id" = "$run_id" ]; then
  exit "$verdict"
fi
if [ "$conclusion" = "success" ] && [ "$previous_conclusion" != "failure" ]; then
  # Green after green (or the very first call): nothing to say.
  exit "$verdict"
fi

if [ "$conclusion" = "failure" ]; then
  subject="eXocortex-CI rot auf $BRANCH"
  body="Commit: $sha $title
$failures

$url"
else
  subject="eXocortex-CI wieder grün"
  body="Commit: $sha $title
$url"
fi

out="$(mktemp -t ci-alert-XXXXXX)"
# --to is mandatory, see backup-alert.sh: without it hermes exits 0 and sends nothing.
/home/johanna/.local/bin/hermes send --to telegram --subject "$subject" "$body" > "$out" 2>&1 || true
if grep -q '^Sent' "$out"; then
  echo "Alert delivered: $(head -n 1 "$out")"
else
  echo "Alert NOT delivered. hermes said:" >&2
  cat "$out" >&2
  # Forget the run, so the next call tries again instead of staying silent.
  printf '%s\n' "$previous" > "$STATE_FILE"
fi
rm -f "$out"

exit "$verdict"
