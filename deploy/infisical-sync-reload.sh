#!/usr/bin/env bash
# Pulls the managed secrets out of Infisical and restarts what needs them.
#
# The sync script exits 10 exactly when it changed the .env, so a run that found
# nothing to do never touches a live unit. Only the worker is restarted: it is
# the process that reads the calendar credentials. The API, web and
# collaboration units hold no Infisical-managed value today, and bouncing them
# would drop live editing sessions for nothing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set +e
python3 "$REPO_ROOT/deploy/infisical-sync-env.py" --apply
status=$?
set -e

case "$status" in
  0)
    echo "infisical-sync: keine Änderung."
    ;;
  10)
    echo "infisical-sync: .env geändert, starte exocortex-worker neu."
    systemctl restart exocortex-worker
    ;;
  *)
    echo "infisical-sync: Fehler (exit $status), nichts neu gestartet." >&2
    exit "$status"
    ;;
esac
