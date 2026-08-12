#!/usr/bin/env bash
# Proves that the newest snapshot on MEGA can actually be restored.
#
# A backup nobody ever restored is a guess. This pulls the latest snapshot back
# out of MEGA (not out of the local copy, so the upload path is tested too),
# decrypts it, loads it into a throwaway database next to the live one and
# checks that the tables a restore would need are populated. The scratch
# database is dropped again at the end, whatever happened.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REMOTE_ROOT="${BACKUP_REMOTE_ROOT:-/Backups/exocortex}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/exocortex/backup-passphrase}"
POSTGRES_CONTAINER="${BACKUP_POSTGRES_CONTAINER:-exocortex-postgres}"
SCRATCH_DB="${BACKUP_SCRATCH_DB:-exocortex_restore_test}"

log() { printf '%s exocortex-backup-verify: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'exocortex-backup-verify: %s\n' "$*" >&2; exit 1; }

env_value() {
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | tail -n 1 | tr -d '"'"'"
}
PG_USER="$(env_value POSTGRES_USER)"; PG_USER="${PG_USER:-exocortex}"
PG_DB="$(env_value POSTGRES_DB)"; PG_DB="${PG_DB:-exocortex}"

latest="$(mega-ls "$REMOTE_ROOT" 2>/dev/null \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' | sort -r | head -n 1)"
[[ -n "$latest" ]] || die "In $REMOTE_ROOT liegt kein Snapshot."

# Not /tmp: the unit runs with PrivateTmp, and megacmd hands the download off to
# a server process outside that namespace, which then cannot see the folder.
work="$(mktemp -d "${BACKUP_LOCAL_ROOT:-/var/backups/exocortex}/verify.XXXXXX")"
cleanup() {
  rm -rf "$work"
  docker exec "$POSTGRES_CONTAINER" dropdb -U "$PG_USER" --if-exists "$SCRATCH_DB" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "Prüfe Snapshot $latest."
fetch() {
  # As in the backup script: megacmd's progress bar goes to stderr and is only
  # interesting when the transfer fails.
  local out
  # tr strips the null bytes megacmd paints its progress bar with.
  out="$(mega-get "$REMOTE_ROOT/$latest/$1" "$work/" 2>&1 | tr -d '\0')" \
    || die "Download von $1 fehlgeschlagen: $out"
}
fetch database.dump.gpg
fetch MANIFEST.txt

expected="$(grep 'database.dump.gpg' "$work/MANIFEST.txt" | awk '{print $1}')"
actual="$(sha256sum "$work/database.dump.gpg" | awk '{print $1}')"
[[ "$expected" == "$actual" ]] \
  || die "Prüfsumme weicht ab: Manifest $expected, geladen $actual."

gpg --batch --yes --quiet --decrypt --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" \
  --output "$work/database.dump" "$work/database.dump.gpg"

log "Spiele in $SCRATCH_DB ein."
docker exec "$POSTGRES_CONTAINER" dropdb -U "$PG_USER" --if-exists "$SCRATCH_DB"
docker exec "$POSTGRES_CONTAINER" createdb -U "$PG_USER" "$SCRATCH_DB"
# pg_restore reports non-fatal noise (extension owners, missing roles) as
# errors; --exit-on-error would fail the test on cosmetics, so the real check
# is the row count below.
docker exec -i "$POSTGRES_CONTAINER" pg_restore -U "$PG_USER" -d "$SCRATCH_DB" \
  --no-owner --no-privileges < "$work/database.dump" || true

counts="$(docker exec "$POSTGRES_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" \
  -tAF' ' -c 'select
    (select count(*) from document),
    (select count(*) from document_content where "yjsState" is not null),
    (select count(*) from workspace),
    (select count(*) from "user"),
    (select count(*) from attachment)')"
read -r documents yjs workspaces users attachments <<<"$counts"

# The Yjs state is the canonical document content (ADR-004/005). A dump that
# restores rows but no binary state would look fine and be worthless.
(( documents > 0 && yjs > 0 && workspaces > 0 && users > 0 )) \
  || die "Restore leer: $documents Dokumente, $yjs Yjs-States, $workspaces Workspaces, $users Nutzer."

log "OK: $documents Dokumente, $yjs Yjs-States, $workspaces Workspaces, $users Nutzer, $attachments Anhänge aus $latest."
