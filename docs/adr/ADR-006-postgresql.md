# ADR-006: PostgreSQL as the application database

- Status: accepted
- Date: 2026-08-04

## Context

eXocortex needs relational integrity (workspaces, memberships, hierarchies), binary
blobs (Yjs state and snapshots), full-text search, typo tolerance and — later —
vector search. It must be self-hostable with a single database engine.

## Decision

PostgreSQL 17 with Prisma 7 as the ORM and Prisma Migrate for schema changes. The
`pgvector` image is used and the `vector` and `pg_trgm` extensions are created in the
initial migration.

Anything Prisma cannot express is written as explicit SQL in the migration:

- a generated, weighted `tsvector` column on `document_search_index` (title weight A,
  body weight B) with a GIN index,
- trigram GIN indexes on titles for typo-tolerant search,
- a `C`-collation index on `(workspaceId, parentId, orderKey)` so the fractional
  index order matches the index order,
- a partial index on unprocessed outbox rows.

## Consequences

- One engine covers relations, blobs, search and future embeddings — a small
  self-hosted deployment needs no additional service.
- Search quality is good enough for tens of thousands of pages. Beyond that,
  `SearchAdapter` allows adding OpenSearch without touching application services.
- `Unsupported("tsvector")` and `Unsupported("vector(1536)")` columns are invisible to
  the Prisma client, so all search queries use `$queryRaw` with parameter binding.
- Prisma 7 connects through a driver adapter and through nothing else, so
  `packages/database/src/client.ts` builds a `PrismaPg` from `DATABASE_URL` and a
  bare `new PrismaClient()` is an error rather than a default. That also ends the
  Rust query engine here: queries are compiled by the WebAssembly compiler in the
  generated client, and `engineType` no longer names anything.
- The connection URL lives in `packages/database/prisma.config.ts`, not in
  `schema.prisma`, because Prisma 7 rejects `url = env(...)` in a datasource
  (P1012). `scripts/check-migrations-reproducible.sh` writes a config of its own
  for the same reason: the URL is the one thing that must not come from the
  repository when the gate replays migrations.
