#!/usr/bin/env bash
# Tells Johanna over Telegram that a backup unit failed.
#
# Wired in as OnFailure= so it fires for a crashed run, a timeout and a
# non-zero exit alike. It must never fail itself: a broken alarm that takes the
# unit down with it would hide the very thing it reports.
set -uo pipefail

unit="${1:-exocortex-backup.service}"
lines="$(sudo -n journalctl -u "$unit" -n 15 --no-pager -o cat 2>/dev/null \
  || echo '(kein Journal lesbar)')"

/home/johanna/.local/bin/hermes send \
  --subject "eXocortex-Backup fehlgeschlagen" \
  "Unit: $unit
Host: $(hostname)
Zeit: $(date -u '+%Y-%m-%d %H:%M UTC')

$lines" >/dev/null 2>&1 || true

exit 0
