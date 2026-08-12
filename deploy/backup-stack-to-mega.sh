#!/usr/bin/env bash
# Encrypted snapshot of the automation stack in /opt/automation-stack, pushed
# to MEGA. Same machinery, same passphrase and same retention as the eXocortex
# snapshot next door, but its own folder and its own timer, because these
# services change on a different rhythm.
#
# A snapshot holds:
#
#   windmill.dump.gpg   pg_dump -Fc of the windmill database: scripts, flows,
#                       schedules, resources, job history.
#   infisical.dump.gpg  pg_dump -Fc of the infisical database. Worthless on its
#                       own: every secret in it is encrypted with
#                       INFISICAL_ENCRYPTION_KEY, which is why the stack's .env
#                       travels in the same snapshot.
#   grafana.db.gpg      the Grafana sqlite database (dashboards built by hand,
#                       users, API keys), copied through the sqlite backup API
#                       so a running Grafana cannot tear it.
#   config.tar.gz.gpg   /opt/automation-stack without data/: the compose files,
#                       .env, secrets/, helpers/, scripts/, monitoring/.
#   MANIFEST.txt        the plain-text inventory.
#
# Deliberately absent: data/prometheus and data/loki (425 MB of time series that
# regenerate themselves and describe a past nobody restores), data/windmill-cache
# (a dependency cache) and the raw postgres data directories, which the dumps
# above replace.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-lib.sh
source "$REPO_ROOT/deploy/backup-lib.sh"

STACK_DIR="${BACKUP_STACK_DIR:-/opt/automation-stack}"
WINDMILL_CONTAINER="${BACKUP_WINDMILL_CONTAINER:-automation-stack-windmill-db-1}"
INFISICAL_CONTAINER="${BACKUP_INFISICAL_CONTAINER:-automation-stack-infisical-db-1}"
GRAFANA_DB="${BACKUP_GRAFANA_DB:-$STACK_DIR/data/grafana/grafana.db}"

# The credentials come from the running container rather than from the stack's
# root-only .env: the .env still needs sudo further down, but the fewer things
# depend on it the better.
container_env() {
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n "s/^$2=//p" | tail -n 1
}
INFISICAL_USER="$(container_env "$INFISICAL_CONTAINER" POSTGRES_USER)"
INFISICAL_DB="$(container_env "$INFISICAL_CONTAINER" POSTGRES_DB)"
INFISICAL_USER="${INFISICAL_USER:-infisical}"
INFISICAL_DB="${INFISICAL_DB:-infisical}"

backup_begin automation-stack "${BACKUP_REMOTE_ROOT:-/Backups/automation-stack}"

backup_log "Dumpe Windmill-Datenbank."
docker exec "$WINDMILL_CONTAINER" pg_dump -U postgres -d windmill -Fc \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/windmill.dump.gpg"

backup_log "Dumpe Infisical-Datenbank $INFISICAL_DB."
docker exec "$INFISICAL_CONTAINER" pg_dump -U "$INFISICAL_USER" -d "$INFISICAL_DB" -Fc \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/infisical.dump.gpg"

if sudo -n test -f "$GRAFANA_DB"; then
  backup_log "Sichere Grafana-Datenbank."
  # A plain copy of a live sqlite file can be torn mid-write. The backup API
  # takes a consistent copy without stopping Grafana.
  sudo -n python3 - "$GRAFANA_DB" <<'PY' | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/grafana.db.gpg"
import sqlite3, sys, tempfile, os
source = sys.argv[1]
with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
    target = handle.name
try:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(target)
    src.backup(dst)
    dst.close()
    src.close()
    with open(target, "rb") as copied:
        while chunk := copied.read(1024 * 1024):
            sys.stdout.buffer.write(chunk)
finally:
    os.unlink(target)
PY
else
  backup_log "Keine Grafana-Datenbank unter $GRAFANA_DB, übersprungen."
fi

backup_log "Packe Konfiguration aus $STACK_DIR."
sudo -n tar czf - -C "$STACK_DIR" --exclude=./data . \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/config.tar.gz.gpg"

backup_manifest <<EOF
stack:      $STACK_DIR (ohne data/)
windmill:   $(docker inspect --format '{{.Config.Image}}' "$WINDMILL_CONTAINER" 2>/dev/null || echo unbekannt)
infisical:  $(docker inspect --format '{{.Config.Image}}' "$INFISICAL_CONTAINER" 2>/dev/null || echo unbekannt)
grafana:    $(docker inspect --format '{{.Config.Image}}' automation-stack-grafana-1 2>/dev/null || echo unbekannt)
EOF

backup_publish
