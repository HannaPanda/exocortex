#!/usr/bin/env bash
# Tells Johanna over Telegram that a backup unit failed.
#
# Wired in as OnFailure= so it fires for a crashed run, a timeout and a
# non-zero exit alike. It must never fail itself: a broken alarm that takes the
# unit down with it would hide the very thing it reports.
set -uo pipefail

unit="${1:-exocortex-backup.service}"
out="$(mktemp -t backup-alert-XXXXXX)"
lines="$(sudo -n journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null \
  || echo '(kein Journal lesbar)')"

# --to is mandatory. Without it hermes prints its usage and sends nothing, and
# it still exits 0 while doing so, so the alarm fails without a trace.
/home/johanna/.local/bin/hermes send \
  --to telegram \
  --subject "eXocortex-Backup fehlgeschlagen" \
  "Unit: $unit
Host: $(hostname)
Zeit: $(date -u '+%Y-%m-%d %H:%M UTC')

$lines" > "$out" 2>&1 || true

# Sending must not take the alarm down, but its outcome belongs in the journal
# rather than in /dev/null: that is what hid the missing --to for months.
if grep -q '^Sent' "$out"; then
  echo "Alert for $unit delivered: $(head -n 1 "$out")"
else
  echo "Alert for $unit NOT delivered. hermes said:" >&2
  cat "$out" >&2
fi
rm -f "$out"

exit 0
