#!/usr/bin/env bash
# Shared machinery for the snapshot scripts next to this file. Sourced, never
# executed. A caller runs three things in order:
#
#   backup_begin <name> <remote-root>   claim the lock, open a snapshot folder
#   ... produce files, each through backup_encrypt_to ...
#   backup_manifest <<< "extra: lines"  write the plain-text inventory
#   backup_publish                      upload, verify, prune, record success
#
# Everything a caller can get wrong lives here exactly once: the retention
# arithmetic in particular, because a bug in it deletes backups rather than
# failing loudly.

BACKUP_LOCAL_BASE="${BACKUP_LOCAL_BASE:-/var/backups}"
BACKUP_PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-/etc/exocortex/backup-passphrase}"

# Retention. The buckets overlap on purpose: a snapshot survives if any one of
# them still wants it.
BACKUP_KEEP_LATEST="${BACKUP_KEEP_LATEST:-8}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-8}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-6}"
BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-4}"

backup_log() { printf '%s %s: %s\n' "$(date -u +%H:%M:%S)" "${BACKUP_NAME:-backup}" "$*"; }
backup_die() { printf '%s: %s\n' "${BACKUP_NAME:-backup}" "$*" >&2; exit 1; }

# Reads the value of one key out of an env file without sourcing it: sourcing
# would let a secret containing a `$` expand into something else and would drag
# unrelated variables into this process.
backup_env_value() {
  local key=$1 file=$2
  sed -n "s/^$key=//p" "$file" | tail -n 1 | tr -d '"'"'"
}

backup_begin() {
  BACKUP_NAME="$1"
  BACKUP_REMOTE_ROOT="$2"
  BACKUP_LOCAL_ROOT="$BACKUP_LOCAL_BASE/$BACKUP_NAME"
  BACKUP_STAMP="$(date -u +%Y-%m-%dT%H%M)"
  BACKUP_SNAPSHOT_DIR="$BACKUP_LOCAL_ROOT/$BACKUP_STAMP"

  [[ -r "$BACKUP_PASSPHRASE_FILE" ]] \
    || backup_die "Passphrase $BACKUP_PASSPHRASE_FILE nicht lesbar."
  mkdir -p "$BACKUP_LOCAL_ROOT"

  # Two runs must never overlap: the second would fight the first for the MEGA
  # session and could upload a half-written dump.
  exec 9>"$BACKUP_LOCAL_ROOT/.lock"
  flock -n 9 || backup_die "Ein anderer Lauf hält noch das Lock."

  mkdir -p "$BACKUP_SNAPSHOT_DIR"
  trap backup_discard_on_failure EXIT
  backup_log "Snapshot $BACKUP_STAMP beginnt."
}

# A run that dies half way must not leave a torn snapshot that a later restore
# could mistake for a good one.
backup_discard_on_failure() {
  local status=$?
  if (( status != 0 )) && [[ -n "${BACKUP_SNAPSHOT_DIR:-}" && -d "$BACKUP_SNAPSHOT_DIR" ]]; then
    backup_log "Lauf fehlgeschlagen (exit $status), verwerfe $BACKUP_SNAPSHOT_DIR."
    rm -rf "$BACKUP_SNAPSHOT_DIR"
  fi
}

# Reads plaintext on stdin, writes ciphertext to $1. --compress-algo none: the
# inputs are compressed already, a second pass only costs CPU.
backup_encrypt_to() {
  gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
    --compress-algo none --pinentry-mode loopback \
    --passphrase-file "$BACKUP_PASSPHRASE_FILE" --output "$1"
}

# Writes MANIFEST.txt: the caller's extra lines on stdin, then the checksums.
# Plain text on purpose, so a stranger to the passphrase can still see what a
# snapshot holds and whether it arrived intact.
backup_manifest() {
  {
    echo "$BACKUP_NAME snapshot $BACKUP_STAMP"
    echo "host:       $(hostname)"
    cat
    echo "cipher:     GPG symmetric AES256"
    echo
    (cd "$BACKUP_SNAPSHOT_DIR" && sha256sum ./*.gpg)
  } > "$BACKUP_SNAPSHOT_DIR/MANIFEST.txt"
}

backup_publish() {
  backup_log "Lade nach $BACKUP_REMOTE_ROOT/$BACKUP_STAMP hoch."
  mega-mkdir -p "$BACKUP_REMOTE_ROOT/$BACKUP_STAMP" >/dev/null 2>&1 || true

  local file transfer_log
  for file in "$BACKUP_SNAPSHOT_DIR"/*; do
    # megacmd paints a progress bar on stderr, with null bytes in it. Swallow
    # both, but keep the text around to print if a transfer actually fails.
    if ! transfer_log="$(mega-put "$file" "$BACKUP_REMOTE_ROOT/$BACKUP_STAMP/" 2>&1 | tr -d '\0')"; then
      backup_die "Upload von $(basename "$file") fehlgeschlagen: $transfer_log"
    fi
  done

  # Trust nothing that was not read back. A silent upload failure is the one
  # failure mode that stays invisible until the day it matters.
  local listing name
  listing="$(mega-ls "$BACKUP_REMOTE_ROOT/$BACKUP_STAMP" 2>/dev/null || true)"
  for file in "$BACKUP_SNAPSHOT_DIR"/*; do
    name="$(basename "$file")"
    grep -qxF "$name" <<<"$listing" \
      || backup_die "$name fehlt nach dem Upload in $BACKUP_REMOTE_ROOT/$BACKUP_STAMP."
  done

  backup_prune_remote
  backup_prune_local

  trap - EXIT
  date -u +%s > "$BACKUP_LOCAL_ROOT/last-success"
  backup_log "Fertig: $(du -sh "$BACKUP_SNAPSHOT_DIR" | cut -f1) in $BACKUP_REMOTE_ROOT/$BACKUP_STAMP."
}

backup_prune_remote() {
  local -a snaps
  mapfile -t snaps < <(mega-ls "$BACKUP_REMOTE_ROOT" 2>/dev/null \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' | sort -r)
  (( ${#snaps[@]} )) || return 0

  local -A keep=()
  local i=0 snap
  for snap in "${snaps[@]}"; do
    (( i++ < BACKUP_KEEP_LATEST )) && keep["$snap"]=1
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
  keep_bucket day "$BACKUP_KEEP_DAILY"
  keep_bucket week "$BACKUP_KEEP_WEEKLY"
  keep_bucket month "$BACKUP_KEEP_MONTHLY"

  for snap in "${snaps[@]}"; do
    [[ -n "${keep[$snap]:-}" ]] && continue
    backup_log "Verwerfe alten Snapshot $snap."
    mega-rm -r -f "$BACKUP_REMOTE_ROOT/$snap" >/dev/null
  done
}

# Local copies are a convenience, not the backup. Keep a handful.
backup_prune_local() {
  local -a local_snaps snap
  mapfile -t local_snaps < <(find "$BACKUP_LOCAL_ROOT" -mindepth 1 -maxdepth 1 -type d \
    -regextype posix-extended -regex '.*/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' \
    -printf '%f\n' | sort -r)
  for snap in "${local_snaps[@]:$BACKUP_KEEP_LOCAL}"; do
    rm -rf "${BACKUP_LOCAL_ROOT:?}/$snap"
  done
}
