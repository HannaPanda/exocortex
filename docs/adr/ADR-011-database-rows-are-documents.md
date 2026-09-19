# ADR-011: Database rows are Documents

- Status: accepted
- Date: 2026-08-05

## Context

Notion-style databases (typed properties, Table/Board/Gallery/Calendar views,
filters, sorts) are mandatory scope, not an optional extra: a knowledge tool
without them loses a large part of what the daily user expects. The question
this ADR settles is what a database _is_ in terms already in the schema, and
what a row _is_, before any API or UI is built on top.

`DocumentType.COLLECTION` already existed in the schema as a reserved,
unused value, placed there specifically so this decision would not require a
migration to even begin.

## Decision

A database is a `Document` with `type: 'COLLECTION'`. Its rows are ordinary
`Document`s with `type: 'PAGE'`, parented under it — ADR-004/005's document
model, unchanged, not a parallel one.

Two new tables carry the schema layered on top:

- `DatabaseProperty` (+ `DatabasePropertyOption` for SELECT/MULTI_SELECT) —
  the typed column definitions of a collection.
- `DatabaseView` — saved Table/Board/Gallery/Calendar views: type, filters,
  sorts, grouping and visible-property configuration.
- `DocumentPropertyValue` — one row per (row, property) pair, with **typed**
  columns (`textValue`, `numberValue`, `boolValue`, `dateValue`, `jsonValue`
  for arrays), not a JSONB blob, so filtering and sorting can use indexed SQL
  instead of scanning and parsing a blob per row.

A dedicated query engine (`packages/database/src/database-query.ts`) compiles
a validated, structured filter/sort tree into parameterized `Prisma.sql`,
following the raw-SQL pattern `packages/database/src/search.ts` already
established. `propertyId` and `operator` are never trusted directly: a
`propertyId` not belonging to the collection being queried is rejected before
any SQL is built, and the column a condition compares against is chosen in
code from the property's _loaded_ type, never from the request — the one
place raw SQL touches anything resembling user input is provably closed
against injection this way.

`RELATION`, `ROLLUP` and `FORMULA` were reserved in the
`DatabasePropertyType` enum from the start so that implementing them would
need no further destructive migration. They were implemented in issue #76, and
that reservation is what made it a change to the query engine rather than to
the schema; how they compute is ADR-041.

## Consequences

Rows get, for free, everything the Document model already has:

- tree position and fractional `orderKey` ordering (`packages/database/src/order-key.ts`),
- full-text search indexing,
- trash/archive and restore,
- Yjs content — a row opens as a completely normal, fully editable page,
- workspace-role authorization (`packages/auth/src/policies.ts` needed no new
  concept; `canManageDatabaseSchema` is a thin alias of `canEditDocument`),
- realtime events, the transactional outbox, and snapshotting.

`DatabaseRowsService.create` in `apps/api/src/databases/database-rows.service.ts`
delegates row creation to `DocumentsService.create` verbatim rather than
re-implementing any part of it — that one call site is where this decision
gets cashed in.

Costs accepted on purpose:

- **One join per property per row.** `DocumentPropertyValue` is looked up
  per (row, property) pair rather than denormalized onto the row; acceptable
  because the query engine fetches all values for a page of rows in one
  `documentPropertyValue.findMany`, not N queries.
- **Yjs overhead for rows that are never opened as pages.** Every row still
  gets a full `DocumentContent` row, an empty Yjs state and a Hocuspocus
  document identity, even in a heavily tabular database whose rows are only
  ever edited through cell inputs. A database with thousands of rows means
  thousands of near-empty Yjs documents, snapshot rows and search-index
  rows. This is a known scaling question, not something this ADR solves —
  worth a load test before very large databases are common, not blocking for
  the initial implementation.
- **Offset pagination once a view sorts or filters.** The fractional
  `orderKey` cursor only works for the default, unsorted order; a sorted or
  filtered query falls back to an offset cursor, which can skip or repeat a
  row if the set changes mid-scroll. Documented as a known limitation in
  `docs/database-views.md`, not silently papered over.
- **RELATION/ROLLUP/FORMULA cost no migration.** Reserving the enum values
  here is what let issue #76 add them as query-engine work alone: a relation
  reuses the `jsonValue` column the array-valued types already write, and a
  rollup and a formula store nothing at all (ADR-041).
