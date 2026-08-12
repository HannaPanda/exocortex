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

LOCAL_ROOT="${BACKUP_LOCAL_ROOT:-/var/backups/exocortex}"
REMOTE_ROOT="${BACKUP_REMOTE_ROOT:-/Backups/exocortex}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/exocortex/backup-passphrase}"

# Retention on MEGA. The buckets overlap on purpose: a snapshot survives if any
# one of them wants it.
KEEP_LATEST="${BACKUP_KEEP_LATEST:-8}"    # the last two days at a 6h cadence
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
# Locally we only keep enough for a fast restore without a download.
KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-4}"

POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-exocortex-postgres}"
MINIO_VOLUME="${BACKUP_MINIO_VOLUME:-exocortex-minio-data}"
TAR_IMAGE="${BACKUP_TAR_IMAGE:-alpine:3.20}"

STAMP="$(date -u +%Y-%m-%dT%H%M)"
SNAPSHOT_DIR="$LOCAL_ROOT/$STAMP"

log() { printf '%s exocortex-backup: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'exocortex-backup: %s\n' "$*" >&2; exit 1; }

[[ -r "$PASSPHRASE_FILE" ]] || die "Passphrase $PASSPHRASE_FILE nicht lesbar."
mkdir -p "$LOCAL_ROOT"

# Two runs must never overlap: the second would fight the first for the MEGA
# session and could upload a half-written dump.
exec 9>"$LOCAL_ROOT/.lock"
flock -n 9 || die "Ein anderer Lauf hält noch das Lock."

# Read the two values we need out of the one .env the deployment has. Sourcing
# the whole file would let a secret containing a `$` expand into something else
# and would drag unrelated variables into this process.
env_value() {
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | tail -n 1 | tr -d '"'"'"
}
PG_USER="$(env_value POSTGRES_USER)"
PG_DB="$(env_value POSTGRES_DB)"
PG_USER="${PG_USER:-exocortex}"
PG_DB="${PG_DB:-exocortex}"

encrypt_to() {
  # Reads plaintext on stdin, writes ciphertext to $1. --compress-algo none:
  # both inputs are compressed already, a second pass only costs CPU.
  gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
    --compress-algo none --pinentry-mode loopback \
    --passphrase-file "$PASSPHRASE_FILE" --output "$1"
}

mkdir -p "$SNAPSHOT_DIR"
# A run that dies half way must not leave a torn snapshot that a later restore
# could mistake for a good one.
cleanup_failed() {
  local status=$?
  if (( status != 0 )) && [[ -d "$SNAPSHOT_DIR" ]]; then
    log "Lauf fehlgeschlagen (exit $status), verwerfe $SNAPSHOT_DIR."
    rm -rf "$SNAPSHOT_DIR"
  fi
}
trap cleanup_failed EXIT

log "Snapshot $STAMP beginnt."

log "Dumpe Datenbank $PG_DB."
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc \
  | encrypt_to "$SNAPSHOT_DIR/database.dump.gpg"

log "Packe MinIO-Volume $MINIO_VOLUME."
# Read-only mount and a throwaway container, so this needs no root on the host
# and cannot touch what the running MinIO is doing.
docker run --rm -v "$MINIO_VOLUME:/data:ro" "$TAR_IMAGE" tar czf - -C /data . \
  | encrypt_to "$SNAPSHOT_DIR/uploads.tar.gz.gpg"

log "Packe Konfiguration."
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
  | encrypt_to "$SNAPSHOT_DIR/config.tar.gz.gpg"

{
  echo "eXocortex snapshot $STAMP"
  echo "host:       $(hostname)"
  echo "git:        $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unbekannt)"
  echo "postgres:   $(docker exec "$POSTGRES_CONTAINER" postgres --version 2>/dev/null || echo unbekannt)"
  echo "minio:      $(docker inspect --format '{{.Config.Image}}' exocortex-minio 2>/dev/null || echo unbekannt)"
  echo "cipher:     GPG symmetric AES256"
  echo "config:     ${existing_config[*]}"
  echo
  (cd "$SNAPSHOT_DIR" && sha256sum ./*.gpg)
} > "$SNAPSHOT_DIR/MANIFEST.txt"

log "Lade nach $REMOTE_ROOT/$STAMP hoch."
mega-mkdir -p "$REMOTE_ROOT/$STAMP" >/dev/null 2>&1 || true
for file in "$SNAPSHOT_DIR"/*; do
  # megacmd paints a progress bar on stderr. Swallow it, but keep it around to
  # print if the transfer actually fails.
  # tr strips the null bytes megacmd paints its progress bar with.
  if ! transfer_log="$(mega-put "$file" "$REMOTE_ROOT/$STAMP/" 2>&1 | tr -d '\0')"; then
    die "Upload von $(basename "$file") fehlgeschlagen: $transfer_log"
  fi
done

# Trust nothing that was not read back. A silent upload failure is the one
# failure mode that stays invisible until the day it matters.
remote_listing="$(mega-ls "$REMOTE_ROOT/$STAMP" 2>/dev/null || true)"
for file in "$SNAPSHOT_DIR"/*; do
  name="$(basename "$file")"
  grep -qxF "$name" <<<"$remote_listing" \
    || die "$name fehlt nach dem Upload in $REMOTE_ROOT/$STAMP."
done

prune_remote() {
  local -a snaps
  mapfile -t snaps < <(mega-ls "$REMOTE_ROOT" 2>/dev/null \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' | sort -r)
  (( ${#snaps[@]} )) || return 0

  local -A keep=()
  local i=0 snap
  for snap in "${snaps[@]}"; do
    (( i++ < KEEP_LATEST )) && keep["$snap"]=1
  done

  keep_bucket() {
    # Snapshots are sorted newest first, so the first hit in a bucket is the
    # one worth keeping.
    local mode=$1 limit=$2 count=0 key
    local -A seen=()
    for snap in "${snaps[@]}"; do
      case "$mode" in
        day)   key="${snap:0:10}" ;;
        week)  key="$(date -u -d "${snap:0:10}" +%G-W%V)" ;;
        month) key="${snap:0:7}" ;;
      esac
      [[ -n "${seen[$key]:-}" ]] && continue
      seen["$key"]=1
      (( ++count > limit )) && break
      keep["$snap"]=1
    done
  }
  keep_bucket day "$KEEP_DAILY"
  keep_bucket week "$KEEP_WEEKLY"
  keep_bucket month "$KEEP_MONTHLY"

  for snap in "${snaps[@]}"; do
    [[ -n "${keep[$snap]:-}" ]] && continue
    log "Verwerfe alten Snapshot $snap."
    mega-rm -r -f "$REMOTE_ROOT/$snap" >/dev/null
  done
}
prune_remote

# Local copies are a convenience, not the backup. Keep a handful.
mapfile -t local_snaps < <(find "$LOCAL_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' \
  -printf '%f\n' | sort -r)
for snap in "${local_snaps[@]:$KEEP_LOCAL}"; do
  rm -rf "${LOCAL_ROOT:?}/$snap"
done

trap - EXIT
date -u +%s > "$LOCAL_ROOT/last-success"
log "Fertig: $(du -sh "$SNAPSHOT_DIR" | cut -f1) in $REMOTE_ROOT/$STAMP."
