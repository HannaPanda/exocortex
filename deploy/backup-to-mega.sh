#!/usr/bin/env bash
# Encrypted snapshot of the eXocortex deployment, pushed to MEGA.
#
# A snapshot is a folder named after a UTC timestamp holding four files:
#
#   database.dump.gpg   pg_dump -Fc of the whole database, including the
#                       canonical Yjs state, the memory workspace and every
#                       account and API token.
#   objects.tar.gz.gpg  every object of the bucket S3_* names, one file per
#                       key, mirrored with `mc` (deploy/backup-lib.sh). Since
#                       issue #272 the uploads live in an external bucket, so
#                       packing the local MinIO volume would silently miss
#                       every file uploaded after the switch. Snapshots from
#                       before 2026-11-26 carry `uploads.tar.gz.gpg`, the raw
#                       MinIO volume, instead.
#   config.tar.gz.gpg   .env, the systemd units, the nginx site, the agent
#                       memory config. Without these a restore is handwork.
#   MANIFEST.txt        sizes, checksums, versions, git commit. Plain text on
#                       purpose: it must be readable without the passphrase.
#
# Snapshots are full, not incremental: each run downloads the whole bucket.
# At ~40 MB that is cheaper than the machinery an incremental scheme would
# need. It stops being so with the large imports issue #272 prepares, and its
# step 2 replaces this part with an incremental backup of the objects.
#
# Redis is deliberately absent: it only holds BullMQ queues, which rebuild
# themselves from the outbox and from the next materialization run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-lib.sh
source "$REPO_ROOT/deploy/backup-lib.sh"

POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-exocortex-postgres}"

PG_USER="$(backup_env_value POSTGRES_USER "$REPO_ROOT/.env")"; PG_USER="${PG_USER:-exocortex}"
PG_DB="$(backup_env_value POSTGRES_DB "$REPO_ROOT/.env")"; PG_DB="${PG_DB:-exocortex}"

backup_begin exocortex "${BACKUP_REMOTE_ROOT:-/Backups/exocortex}"

backup_log "Dumpe Datenbank $PG_DB."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/database.dump.gpg"

backup_log "Spiegele den Objektspeicher."
backup_object_store "$REPO_ROOT/.env"
# Beside the snapshot folder, not in it: backup_publish uploads everything in
# there. Removed on every exit, the failing ones included.
objects_dir="$(mktemp -d "$BACKUP_LOCAL_ROOT/objects.XXXXXX")"
remove_objects_dir() { local status=$?; rm -rf "$objects_dir"; return "$status"; }
trap 'remove_objects_dir; backup_discard_on_failure' EXIT
backup_mc "$objects_dir" rw mirror --quiet "store/$BACKUP_OBJECT_BUCKET" /objects >/dev/null
object_count="$(find "$objects_dir" -type f | wc -l)"
object_bytes="$(du -sb "$objects_dir" | cut -f1)"
live_attachments="$(docker exec "$POSTGRES_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  'select count(*) from attachment where "deletedAt" is null')"
# An empty mirror next to live attachments is a wrong bucket or wrong keys, not
# an empty deployment. Better no snapshot than one that looks complete.
(( object_count > 0 || live_attachments == 0 )) \
  || backup_die "Objektspeicher leer, aber $live_attachments Anhänge in der Datenbank."
backup_log "$object_count Objekte, $object_bytes Bytes."
tar czf - -C "$objects_dir" . | backup_encrypt_to "$BACKUP_SNAPSHOT_DIR/objects.tar.gz.gpg"
rm -rf "$objects_dir"

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
objects:    $object_count Objekte, $object_bytes Bytes, $live_attachments Anhänge in der Datenbank
config:     ${existing_config[*]}
EOF

backup_publish
