#!/usr/bin/env bash
# Writes the objects of a snapshot back into a bucket.
#
#   deploy/backup-restore-objects.sh <objects.tar.gz> [env-file]
#
# <objects.tar.gz> is the decrypted `objects.tar.gz.gpg` of a snapshot
# (deploy/backup-to-mega.sh): one file per object key. The target is the bucket
# the env file's S3_* variables name, the deployment's .env by default. The
# restore test (deploy/backup-restore-test.sh) runs this same script against a
# throwaway MinIO, so the path a real restore takes is proven every week.
#
# Nothing is overwritten and nothing is deleted: an object that already exists
# under the same key is left alone, so running this against a bucket that only
# lost part of its objects fills the gaps. The content type is set from the
# file extension; the database keeps the real one, and every download goes
# through the API, which sends it from there.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-lib.sh
source "$REPO_ROOT/deploy/backup-lib.sh"
BACKUP_NAME=restore-objects

archive=${1:-}
env_file=${2:-$REPO_ROOT/.env}
[[ -r "$archive" ]] || backup_die "Aufruf: $0 <objects.tar.gz> [env-datei]"
[[ -r "$env_file" ]] || backup_die "$env_file nicht lesbar."

work_base="${BACKUP_LOCAL_BASE}/exocortex"
mkdir -p "$work_base"
work="$(mktemp -d "$work_base/restore-objects.XXXXXX")"
trap 'rm -rf "$work"' EXIT

tar xzf "$archive" -C "$work"
count="$(find "$work" -type f | wc -l)"
backup_log "Schreibe $count Objekte zurück."

backup_object_store "$env_file"
backup_mc "$work" ro mirror --quiet /objects "store/$BACKUP_OBJECT_BUCKET" >/dev/null
backup_log "Fertig: $count Objekte im Bucket $BACKUP_OBJECT_BUCKET."
