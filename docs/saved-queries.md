# Saved searches, smart views and query blocks

Issue #74, [ADR-042](adr/ADR-042-a-saved-query-stores-the-question.md).

One stored question behind three surfaces. Nothing here stores an answer, and
the whole design follows from that: see the ADR for why a cached result list
was refused.

## What a saved query is

A row in `saved_query`. Not a `Document`: it owns no rows and names pages that
exist for their own reasons.

| Column                  | Meaning                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `name`, `description`   | What the picker, the navigation and the palette show                |
| `icon`, `iconColor`     | Same two spellings a page icon has: an emoji or `lucide:<name>`     |
| `definition`            | The question. `savedQueryDefinitionSchema`, validated on every read |
| `display`               | Layout of the answer. Presentation only                             |
| `inSidebar`, `orderKey` | Whether it is a smart view, and where among them                    |

The three surfaces:

| Surface      | What it is                                                   |
| ------------ | ------------------------------------------------------------ |
| Saved search | The row, opened at `/arbeitsbereich/:id/suche/:savedQueryId` |
| Smart view   | The same row with `inSidebar`, listed in the navigation      |
| Query block  | A `savedQueryEmbed` node holding the row's id and a limit    |

## The definition

Every field is optional with a neutral default, so `{}` is the valid query
"everything in this workspace, newest first".

| Field                            | What it narrows                                                           |
| -------------------------------- | ------------------------------------------------------------------------- |
| `text`, `textMode`               | The words. `HYBRID` is the search box; `KEYWORD` is full-text alone       |
| `types`                          | `PAGE`, `COLLECTION`, `PROJECT`. Empty means all                          |
| `underDocumentId`                | A subtree, walked recursively **when the query runs**                     |
| `collectionId`, `propertyFilter` | Rows of one database, filtered by the database view's own filter engine   |
| `entityIds`, `entityMatch`       | Pages mentioning the entities, any of them or all of them                 |
| `updated`, `created`             | `withinDays` for a window that keeps moving, else `after`/`before`        |
| `includeArchived`                | Whether the trash counts                                                  |
| `sort`, `limit`                  | Order and how many. `RELEVANCE` without a text falls back to newest first |

`propertyFilter` requires `collectionId`; the contract refuses the pair without
it, because a property id means nothing outside the database that defines it.

## How a query is answered

`runSavedQuery` in `packages/database/src/saved-query.ts`. Two halves, in this
order and not the other one:

1. **The words**, if there are any. The adapter (`HybridSearchAdapter`, or
   `PostgresSearchAdapter` for `KEYWORD`) is asked for `candidateLimit(limit)`
   hits: six times the limit, floor 120, ceiling 400.
2. **Everything else**, as one SQL predicate over the alias `document`, built
   by `compileStructuralFilter`. With candidates it runs as
   `id IN (...) AND <predicate>`; without a text it runs alone with the
   `ORDER BY` and the limit in the database.
3. The surviving rows are put back in the adapter's order (that is what
   `RELEVANCE` means) or re-sorted in memory for the other orders, then cut to
   the limit.

The alias matters: `compileFilterGroup` writes `document."..."` into the
property conditions, so the statement has to spell the table that way.

`truncated` is true when the limit cut the list, and also when the adapter
stopped at its ceiling. Every surface says so in words.

## Adding a dimension

1. Add the field to `savedQueryDefinitionSchema`
   (`packages/contracts/src/saved-queries.ts`) with a neutral default, so every
   stored definition keeps parsing.
2. Compile it in `compileStructuralFilter`. Never concatenate a value into SQL:
   bind it, and use `Prisma.raw` only for a column name chosen in code.
3. Add a case to `packages/database/src/saved-query.test.ts` asserting the
   value lands in `sql.values` and not in `sql.sql`.
4. Add a control to `SavedQueryBuilder`
   (`apps/web/src/components/search/saved-query-builder.tsx`).
5. Extend `DEFINITION_HELP` in `packages/mcp-tools/src/tools/saved-queries.ts`.
   It is one string shared by three tool descriptions, so a model learns the
   new dimension everywhere at once.
6. Amend the `gespeicherte-suchen` entry in `packages/features`.

## API and tools

| Route                                            | Tool                      |
| ------------------------------------------------ | ------------------------- |
| `GET /api/workspaces/:id/saved-queries`          | `exo_saved_query_list`    |
| `POST /api/workspaces/:id/saved-queries`         | `exo_saved_query_create`  |
| `POST /api/workspaces/:id/saved-queries/preview` | `exo_saved_query_preview` |
| `GET /api/saved-queries/:id`                     | `exo_saved_query_get`     |
| `PATCH /api/saved-queries/:id`                   | `exo_saved_query_update`  |
| `POST /api/saved-queries/:id/position`           | `exo_saved_query_reorder` |
| `DELETE /api/saved-queries/:id`                  | `exo_saved_query_delete`  |
| `GET /api/saved-queries/:id/results`             | `exo_saved_query_run`     |

Running is a `GET`, because it changes nothing and a query block re-reads it on
every page view.

## Where it is in the UI

- `/arbeitsbereich/:id/suche` is the search area: the builder, the live result
  list and "Suche speichern".
- `/arbeitsbereich/:id/suche/:savedQueryId` is the same screen with a name on
  it, plus the layout picker, the navigation switch and "Löschen".
- The navigation lists the smart views under the page tree
  (`apps/web/src/components/shell/smart-views.tsx`).
- `Strg+K` lists them by name and offers the search area.
- The slash menu's "Gespeicherte Suche einbetten" inserts the block; its node
  view is `apps/web/src/components/search/saved-query-node-view.tsx`.

Both pages run the _local_ definition rather than the stored one, so editing a
filter changes the list under it immediately and "Änderungen speichern" stores
exactly what is on screen.
