#!/usr/bin/env bash
# Proves that the newest snapshots on MEGA can actually be restored.
#
# A backup nobody ever restored is a guess. For each snapshot family this pulls
# the latest snapshot back out of MEGA (not out of the local copy, so the upload
# path is tested too), checks it against the manifest checksum, loads it into a
# throwaway database next to the live one and fails unless the tables a restore
# would need come back populated. Every scratch database is dropped again at the
# end, whatever happened.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/backup-lib.sh
source "$REPO_ROOT/deploy/backup-lib.sh"
BACKUP_NAME=backup-verify

# Not /tmp: the unit runs with PrivateTmp, and megacmd hands downloads off to a
# server process outside that namespace, which then cannot see the folder.
WORK_BASE="${BACKUP_LOCAL_BASE}/exocortex"
mkdir -p "$WORK_BASE"
work="$(mktemp -d "$WORK_BASE/verify.XXXXXX")"
declare -a scratch_dbs=()
cleanup() {
  rm -rf "$work"
  local entry container user db
  for entry in "${scratch_dbs[@]}"; do
    IFS='|' read -r container user db <<<"$entry"
    docker exec "$container" dropdb -U "$user" --if-exists "$db" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Downloads one file of the newest snapshot in $1 and checks it against the
# manifest that travelled with it.
fetch_verified() {
  local remote_root=$1 latest=$2 file=$3 out expected actual
  # megacmd's progress bar goes to stderr with null bytes in it, and is only
  # interesting when the transfer fails.
  out="$(mega-get "$remote_root/$latest/$file" "$work/" 2>&1 | tr -d '\0')" \
    || backup_die "Download von $file fehlgeschlagen: $out"
  expected="$(grep -F "$file" "$work/MANIFEST.txt" | awk '{print $1}')"
  actual="$(sha256sum "$work/$file" | awk '{print $1}')"
  [[ -n "$expected" && "$expected" == "$actual" ]] \
    || backup_die "Prüfsumme von $file weicht ab: Manifest ${expected:-fehlt}, geladen $actual."
  gpg --batch --yes --quiet --decrypt --pinentry-mode loopback \
    --passphrase-file "$BACKUP_PASSPHRASE_FILE" \
    --output "$work/${file%.gpg}" "$work/$file"
}

newest_snapshot() {
  mega-ls "$1" 2>/dev/null \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$' | sort -r | head -n 1
}

# Restores $4 into a fresh scratch database and returns the row counts of $6.
restore_into_scratch() {
  local container=$1 user=$2 scratch=$3 dump=$4
  scratch_dbs+=("$container|$user|$scratch")
  docker exec "$container" dropdb -U "$user" --if-exists "$scratch"
  docker exec "$container" createdb -U "$user" "$scratch"
  # pg_restore reports non-fatal noise (extension owners, missing roles) as
  # errors; --exit-on-error would fail the test on cosmetics, so the real check
  # is the row count each caller makes afterwards.
  docker exec -i "$container" pg_restore -U "$user" -d "$scratch" \
    --no-owner --no-privileges < "$dump" || true
}

count_in_scratch() {
  local container=$1 user=$2 scratch=$3 sql=$4
  docker exec "$container" psql -U "$user" -d "$scratch" -tAF' ' -c "$sql"
}

# --- eXocortex ---------------------------------------------------------------

exo_root="${BACKUP_REMOTE_ROOT:-/Backups/exocortex}"
exo_latest="$(newest_snapshot "$exo_root")"
[[ -n "$exo_latest" ]] || backup_die "In $exo_root liegt kein Snapshot."
backup_log "Prüfe eXocortex-Snapshot $exo_latest."

mega-get "$exo_root/$exo_latest/MANIFEST.txt" "$work/" >/dev/null 2>&1 \
  || backup_die "MANIFEST.txt aus $exo_latest nicht ladbar."
fetch_verified "$exo_root" "$exo_latest" database.dump.gpg

exo_user="$(backup_env_value POSTGRES_USER "$REPO_ROOT/.env")"; exo_user="${exo_user:-exocortex}"
restore_into_scratch exocortex-postgres "$exo_user" exocortex_restore_test "$work/database.dump"
read -r documents yjs workspaces users attachments < <(count_in_scratch \
  exocortex-postgres "$exo_user" exocortex_restore_test \
  'select
     (select count(*) from document),
     (select count(*) from document_content where "yjsState" is not null),
     (select count(*) from workspace),
     (select count(*) from "user"),
     (select count(*) from attachment)')

# The Yjs state is the canonical document content (ADR-004/005). A dump that
# restores rows but no binary state would look fine and be worthless.
(( documents > 0 && yjs > 0 && workspaces > 0 && users > 0 )) \
  || backup_die "eXocortex-Restore leer: $documents Dokumente, $yjs Yjs-States, $workspaces Workspaces, $users Nutzer."
backup_log "eXocortex OK: $documents Dokumente, $yjs Yjs-States, $workspaces Workspaces, $users Nutzer, $attachments Anhänge aus $exo_latest."

# --- Automation stack --------------------------------------------------------

stack_root="${BACKUP_STACK_REMOTE_ROOT:-/Backups/automation-stack}"
stack_latest="$(newest_snapshot "$stack_root")"
[[ -n "$stack_latest" ]] || backup_die "In $stack_root liegt kein Snapshot."
backup_log "Prüfe Automation-Stack-Snapshot $stack_latest."

rm -f "$work/MANIFEST.txt"
mega-get "$stack_root/$stack_latest/MANIFEST.txt" "$work/" >/dev/null 2>&1 \
  || backup_die "MANIFEST.txt aus $stack_latest nicht ladbar."
fetch_verified "$stack_root" "$stack_latest" windmill.dump.gpg
fetch_verified "$stack_root" "$stack_latest" infisical.dump.gpg

restore_into_scratch automation-stack-windmill-db-1 postgres windmill_restore_test \
  "$work/windmill.dump"
read -r scripts flows schedules resources < <(count_in_scratch \
  automation-stack-windmill-db-1 postgres windmill_restore_test \
  'select (select count(*) from script),(select count(*) from flow),
          (select count(*) from schedule),(select count(*) from resource)')
(( scripts > 0 && schedules > 0 )) \
  || backup_die "Windmill-Restore leer: $scripts Skripte, $schedules Zeitpläne."
backup_log "Windmill OK: $scripts Skripte, $flows Flows, $schedules Zeitpläne, $resources Ressourcen."

infisical_user="$(docker inspect automation-stack-infisical-db-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | sed -n 's/^POSTGRES_USER=//p' | tail -n 1)"
infisical_user="${infisical_user:-infisical}"
restore_into_scratch automation-stack-infisical-db-1 "$infisical_user" infisical_restore_test \
  "$work/infisical.dump"
read -r secrets projects infisical_users < <(count_in_scratch \
  automation-stack-infisical-db-1 "$infisical_user" infisical_restore_test \
  'select (select count(*) from secrets_v2),(select count(*) from projects),
          (select count(*) from users)')
(( secrets > 0 && projects > 0 && infisical_users > 0 )) \
  || backup_die "Infisical-Restore leer: $secrets Secrets, $projects Projekte, $infisical_users Nutzer."
backup_log "Infisical OK: $secrets Secrets, $projects Projekte, $infisical_users Nutzer."
