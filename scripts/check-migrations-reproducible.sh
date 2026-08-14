#!/usr/bin/env bash
#
# Gate: the migration history rebuilds the schema from zero.
#
# Replays every migration in `packages/database/prisma/migrations` onto a
# throwaway Postgres and asserts the result is identical to `schema.prisma`.
# That single comparison catches every way the history can rot:
#
#   * `prisma db push` holes    -- objects in the live database that no
#                                  migration creates
#   * hand-patched migrations   -- a `migration.sql` edited after it was
#                                  applied, so the repository no longer
#                                  reproduces the database
#   * un-migrated drift         -- `schema.prisma` changed without a migration
#
# This deployment is more exposed to that than most: `prisma migrate dev` wants
# to drop the search index every time it runs, so migrations here are written by
# hand (see the "Prisma migrations" note in the project memory). A hand-written
# migration is exactly the kind that can work against the live database and
# still not replay from zero.
#
# It never touches the live database. Everything happens inside a disposable
# container, and Prisma is run from a scratch directory holding a copy of the
# schema so it cannot pick up the repository's `.env` -- `packages/database/.env`
# is a symlink to the root one, which points at production.
#
# Exit 0  => a database built purely from migrations equals schema.prisma
# Exit 1  => the history is not reproducible, and a deploy must be blocked
#
# There is deliberately no --force or --skip. If the gate cannot run (Docker
# missing, say) it fails rather than waving the deploy through: an unverifiable
# history is the situation it exists to catch.

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DB_DIR="$ROOT_DIR/packages/database"
PRISMA="$DB_DIR/node_modules/.bin/prisma"

# pgvector, not plain postgres: the first migration does `CREATE EXTENSION
# vector`, so a stock image fails on migration one and reports it as drift.
PG_IMAGE="${EXOCORTEX_MIGRATION_PG_IMAGE:-pgvector/pgvector:pg17}"
CONTAINER="exocortex-migration-gate-$$"

say()  { echo -e "${CYAN}[migration-gate]${NC} $1"; }
fail() { echo -e "${RED}[migration-gate] ✗ $1${NC}" >&2; exit 1; }
ok()   { echo -e "${GREEN}[migration-gate] ✓ $1${NC}"; }

command -v docker >/dev/null 2>&1 \
  || fail "Docker is required for the migration gate but was not found."
docker info >/dev/null 2>&1 \
  || fail "Docker is installed but not usable (daemon down, or no permission)."
[ -x "$PRISMA" ] \
  || fail "Prisma CLI not found at $PRISMA — run 'pnpm install' first."

WORKDIR="$(mktemp -d)"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# A scratch copy, run with the scratch directory as cwd. Prisma looks for a
# `.env` next to the schema and in the working directory; both are inside
# $WORKDIR here, and neither exists, so DATABASE_URL can only come from the
# environment set below. Without this the gate would silently replay migrations
# against the production database.
mkdir -p "$WORKDIR/prisma"
cp -R "$DB_DIR/prisma/migrations" "$WORKDIR/prisma/migrations"
cp "$DB_DIR/prisma/schema.prisma" "$WORKDIR/prisma/schema.prisma"

say "Starting a throwaway Postgres ($PG_IMAGE) …"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=gate -e POSTGRES_USER=gate -e POSTGRES_DB=gate \
  -p 127.0.0.1:0:5432 "$PG_IMAGE" >/dev/null \
  || fail "Could not start the throwaway Postgres container."

HOSTPORT=$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')
[ -n "$HOSTPORT" ] || fail "Could not determine the throwaway Postgres port."
export DATABASE_URL="postgresql://gate:gate@127.0.0.1:${HOSTPORT}/gate?schema=public"

say "Waiting for Postgres to accept connections …"
for i in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U gate >/dev/null 2>&1 && break
  [ "$i" = "30" ] && fail "The throwaway Postgres did not become ready in time."
  sleep 1
done

cd "$WORKDIR"

say "Replaying the full migration history from zero …"
if ! "$PRISMA" migrate deploy --schema prisma/schema.prisma >"$WORKDIR/deploy.log" 2>&1; then
  echo -e "${YELLOW}---- migrate deploy output ----${NC}" >&2
  tail -25 "$WORKDIR/deploy.log" >&2
  fail "The history could not be replayed on a fresh database. A migration does not stand on its own (it ALTERs something no earlier migration CREATEs, or it was edited after being applied)."
fi

# Objects the Prisma datamodel cannot describe, so `migrate diff` always wants
# to drop them. They are created by raw SQL in a migration and modelled as
# `Unsupported(...)` in schema.prisma (see the header comment there): full-text
# and trigram indexes, the HNSW index for semantic search, the GIN index on the
# property values, and the generated tsvector's default.
#
# Full-line exact matches on purpose. A pattern like "any DROP INDEX on
# document_*" would also swallow the real drift this gate exists to find.
#
# Every entry must actually appear in the diff. An entry that no longer matches
# is a hole in the gate, so a stale one is reported as red rather than ignored
# -- removing the index means removing the line here in the same commit.
UNMODELLABLE=(
  'DROP INDEX "document_title_trgm_idx";'
  'DROP INDEX "document_embedding_embedding_hnsw_idx";'
  'DROP INDEX "document_property_value_json_gin";'
  'DROP INDEX "document_search_index_searchVector_idx";'
  'DROP INDEX "document_search_index_title_trgm_idx";'
  'ALTER TABLE "document_search_index" ALTER COLUMN "searchVector" DROP DEFAULT;'
)

say "Comparing the fresh database against schema.prisma …"
DIFF=$("$PRISMA" migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script 2>/dev/null)

STALE=()
REMAINING="$DIFF"
for statement in "${UNMODELLABLE[@]}"; do
  if ! grep -qxF "$statement" <<<"$REMAINING"; then
    STALE+=("$statement")
    continue
  fi
  REMAINING=$(grep -vxF "$statement" <<<"$REMAINING")
done

if [ ${#STALE[@]} -gt 0 ]; then
  echo -e "${YELLOW}---- allow-list entries that no longer match anything ----${NC}" >&2
  printf '  %s\n' "${STALE[@]}" >&2
  fail "The UNMODELLABLE allow-list in this script is stale. Each entry silently hides a difference, so an entry that matches nothing is a hole. Remove it here in the same commit that removed the object."
fi

# Prisma prints comment lines only ("-- This is an empty migration.") when there
# is nothing to do. Any non-blank, non-comment line left after the allow-list is
# real drift.
if grep -qvE '^\s*(--.*)?$' <<<"$REMAINING"; then
  echo -e "${YELLOW}---- drift between a fresh migration build and schema.prisma ----${NC}" >&2
  grep -vE '^\s*(--.*)?$' <<<"$REMAINING" >&2
  echo -e "${YELLOW}----------------------------------------------------------------${NC}" >&2
  fail "A database built purely from migrations does NOT match schema.prisma. Something reached the live database without a migration. Write the migration that closes the gap by hand (never 'migrate dev' here), then re-run."
fi

ok "Migration history replays from zero and matches schema.prisma."
