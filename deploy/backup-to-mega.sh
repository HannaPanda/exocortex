#!/usr/bin/env bash
# Encrypted snapshot of the eXocortex deployment, pushed to MEGA.
#
# A snapshot is a folder named after a UTC timestamp holding four files:
#
#   database.dump.gpg   pg_dump -Fc of the whole database, including the
#                       canonical Yjs state, the memory workspace and every
#                       account and API token.
#   uploads.tar.gz.gpg  the raw MinIO volume, so object metadata survives.
#   config.tar.gz.gpg   .env, the systemd units, the nginx site, the agent
#                       memory config. Without these a restore is handwork.
#   MANIFEST.txt        sizes, checksums, versions, git commit. Plain text on
#                       purpose: it must be readable without the passphrase.
#
# Snapshots are full, not incremental. At ~40 MB a run that is cheaper than the
# machinery an incremental scheme would need, and a restore stays two commands.
# Revisit that when the uploads pass ~20 GB.
#
# Redis is deliberately absent: it only holds BullMQ queues, which rebuild
# themselves from the outbox and from the next materialization run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-lib.sh
source "$REPO_ROOT/deploy/backup-lib.sh"

POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-exocortex-postgres}"
MINIO_VOLUME="${BACKUP_MINIO_VOLUME:-exocortex-minio-data}"
TAR_IMAGE="${BACKUP_TAR_IMAGE:-alpine:3.20}"

PG_USER="$(backup_env_value POSTGRES_USER "$REPO_ROOT/.env")"; PG_USER="${PG_USER:-exocortex}"
PG_DB="$(backup_env_value POSTGRES_DB "$REPO_ROOT/.env")"; PG_DB="${PG_DB:-exocortex}"

backup_begin exocortex "${BACKUP_REMOTE_ROOT:-/Backups/exocortex}"

backup_log "Dumpe Datenbank $PG_DB."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/database.dump.gpg"

backup_log "Packe MinIO-Volume $MINIO_VOLUME."
# Read-only mount and a throwaway container, so this needs no root on the host
# and cannot touch what the running MinIO is doing.
docker run --rm -v "$MINIO_VOLUME:/data:ro" "$TAR_IMAGE" tar czf - -C /data . \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/uploads.tar.gz.gpg"

backup_log "Packe Konfiguration."
config_files=(
  "$REPO_ROOT/.env"
  /etc/systemd/system/exocortex-*.service
  /etc/systemd/system/exocortex-*.timer
  /etc/nginx/sites-available/exocortex
  "$HOME/.claude/exocortex-memory.json"
)
existing_config=()
for path in "${config_files[@]}"; do
  [[ -r "$path" ]] && existing_config+=("$path")
done
tar czf - --absolute-names "${existing_config[@]}" \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/config.tar.gz.gpg"

backup_manifest <<EOF
git:        $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unbekannt)
postgres:   $(docker exec "$POSTGRES_CONTAINER" postgres --version 2>/dev/null || echo unbekannt)
minio:      $(docker inspect --format '{{.Config.Image}}' exocortex-minio 2>/dev/null || echo unbekannt)
config:     ${existing_config[*]}
EOF

backup_publish
