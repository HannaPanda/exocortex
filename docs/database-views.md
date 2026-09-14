# Database views

Notion-style typed databases: a `Document` with `type: 'COLLECTION'`, typed
`DatabaseProperty` columns, saved `DatabaseView`s (Table/Board/Gallery/Calendar)
and rows that are ordinary `Document`s (`type: 'PAGE'`) underneath it. Read
`docs/adr/ADR-011-database-rows-are-documents.md` first — this document is the
"how to extend" recipe, the ADR is the "why".

## The pieces

| Layer        | File                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema       | `packages/database/prisma/schema.prisma` — `DatabaseProperty`, `DatabasePropertyOption`, `DatabaseView`, `DocumentPropertyValue`                                                                                                                    |
| Query engine | `packages/database/src/database-query.ts` — compiles a validated filter/sort tree to parameterized SQL                                                                                                                                              |
| Contracts    | `packages/contracts/src/database-views.ts` — property/view/filter/row schemas                                                                                                                                                                       |
| API          | `apps/api/src/databases/` — `database-properties.*`, `database-views.*`, `database-rows.*` (service + controller each)                                                                                                                              |
| Frontend     | `apps/web/src/components/database/` — `database-shell.tsx` dispatches to `table-view.tsx` / `board-view.tsx` / `gallery-view.tsx` / `calendar-view.tsx`, all reading rows through `use-database-query`-style hooks in `lib/api/database-queries.ts` |

All four view types share one query path (`POST /api/documents/:id/rows/query`
→ `queryDatabaseRows`); they differ only in how they lay the same rows out.

## Adding a new property type

1. Add the value to `DatabasePropertyType` in `schema.prisma` and run a
   migration (additive: a new enum value never needs a destructive
   migration).
2. Add it to `databasePropertyTypeSchema` in
   `packages/contracts/src/database-views.ts`, and to
   `IMPLEMENTED_PROPERTY_TYPES` once the type is ready to accept writes
   (leaving it out of that list, like `RELATION`/`ROLLUP`/`FORMULA` today,
   reserves the enum value while rejecting creation with
   `database_property_reserved`).
3. Map it to a `document_property_value` column in
   `packages/database/src/database-query.ts`'s `columnForType` (query side)
   and in `apps/api/src/databases/database-rows.service.ts`'s `toColumnData`
   /`storedToResponseValue` (write/read side). A genuinely new storage shape
   needs a new typed column on `DocumentPropertyValue`, not a JSONB
   catch-all — see ADR-011 for why.
4. Add a cell editor to `apps/web/src/components/database/cells.tsx` and
   register it in `PropertyCell`'s switch. Add a compact, non-interactive
   rendering branch to `PropertyValueDisplay` in the same file for Board/Gallery
   card summaries — these are two different rendering modes on purpose: a
   table cell is a form control, a card summary is read-only text, and a
   `<input type="date" readOnly>` still shows browser date-picker chrome that
   a plain formatted string does not.
5. Add a German label in `PROPERTY_TYPE_LABELS`
   (`apps/web/src/components/database/property-types.ts`) and, if it should
   be filterable, entries in `FILTER_OPERATOR_LABELS`/`operatorsForType`.

## Dates: point in time or span

A `DATE` property answers in one of two shapes, and which one is decided by the
property's `config`, never by the individual row. `parseDatePropertyConfig`
(contracts) reads the bag with defaults, so a property created before the field
existed keeps behaving exactly as it did.

| `config` field | Effect                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `includeTime`  | The value carries a time of day. Editors switch from `<input type="date">` to `<input type="datetime-local">`, and rendering shows the time.                                                             |
| `isRange`      | The value is a span. **This changes the response shape** of every value of that property: `false` returns the bare ISO string, `true` returns `{ start, end, allDay }` (`databaseDateRangeValueSchema`). |
| `timeZone`     | IANA zone the wall-clock parts were authored in. Stored instants are always UTC; this only records the authoring zone.                                                                                   |

Storage is three columns on `DocumentPropertyValue`: `dateValue` (the instant,
and the start of a span), `dateEndValue` (exclusive end, null = no stated end,
which is _not_ a zero-length span) and `dateAllDay` (per value, because one
calendar holds birthdays and 14:00 meetings).

Two rules that are easy to get wrong:

- **Writes always accept the bare ISO string**, in both modes, so every existing
  writer (MCP catalogue, Hermes, the morning briefing) keeps working. The span
  object is accepted only where `isRange` is true; sending it to a non-range
  property is rejected rather than silently truncated.
- **Turning `isRange` off is refused** while rows still carry an end
  (`database_property_date_range_in_use`, 409). Clearing those ends first is the
  caller's decision.

An all-day value is a _floating_ calendar date stored as UTC midnight. Read it
off the ISO string; converting it into the viewer's zone shifts every birthday a
day for anyone west of Greenwich. A timed value is a real instant and belongs in
the day the _viewer_ sees it in. `dayKeyOf` in `calendar-view.tsx` is the one
place that decision lives.

### The `overlaps` filter operator

`overlaps` takes `value: [fromIso, toIso]` and matches every row whose span
intersects the half-open window `[from, to)`. It is the query behind a calendar
view and the only condition that reads two columns of one property, so it
compiles to an `EXISTS` subquery rather than the scalar `valueSubquery` the other
operators use. A value with no end counts as a point in time, so the operator
works on both kinds of DATE property. Served by the
`(propertyId, dateValue, dateEndValue)` index.

## Adding a new view type

1. Add it to `DatabaseViewType` in `schema.prisma` (migration) and
   `databaseViewTypeSchema` in contracts.
2. Add a renderer in `apps/web/src/components/database/`, taking the same
   props shape the other four use (`workspaceId`, `documentId`, `view`,
   `properties`, `readOnly`) and reading rows via `useDatabaseRows(documentId,
{ viewId: view.id, limit: 100 })` — **100 is the API's pagination
   ceiling** (`paginationSchema` in `packages/contracts/src/primitives.ts`);
   requesting more throws `validation_failed`.
3. Wire it into `database-shell.tsx`'s per-type dispatch and into
   `view-tabs.tsx`'s `VIEW_TYPE_LABELS`/`VIEW_TYPE_ICONS`/`VIEW_TYPES` so the
   "+" menu can create one.
4. If the view needs extra per-view configuration (Calendar's
   `datePropertyId`, Gallery's `coverPropertyId`), add it to
   `databaseViewConfigSchema` in contracts — it is a free-form JSON column on
   `DatabaseView`, validated at the contract boundary, no migration needed
   for a new config field.

## Table density and column layout

Three fields in `view.config` describe how a TABLE view lays itself out, all
edited through the "Ansicht" popover (`view-options-menu.tsx`) or the resize
handles in the header, all read through
`apps/web/src/components/database/table-columns.ts`:

| Field               | Meaning                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `columnWidths`      | Width per property id in CSS pixels, plus the reserved key `title` for the row-title column (a row's title lives on the `Document`, so it has no property id). Missing key means `DATABASE_COLUMN_DEFAULT_WIDTH`. |
| `rowHeight`         | `short`/`medium`/`tall` = 1/3/6 lines per cell. A clamp, never a data limit: the full value is always reachable in the cell overlay and in the row sheet.                                                         |
| `visibleProperties` | Which columns are shown, and in which order. A property **missing** from the list counts as visible, so a newly created property appears without the view having to be updated.                                   |

Moving a column one step is in the column header menu ("Nach links" / "Nach
rechts"), and it writes to one of two places, which is the part worth knowing:
a view that already has a `visibleProperties` list of its own is rewritten in
place, and a view that has none follows the database's property order, so the
property itself moves through `POST /api/documents/:id/properties/:id/reorder`.
Picking the wrong one would not look like a failure -- the click would simply
do nothing -- so `hasOwnColumnOrder()` decides, not the reader. The view tabs
move the same way through their context menu, which is `reorder` on the view.

Two related rules follow from `rowHeight` being a clamp:

- A cell never truncates without a way out. Text-ish cells
  (`ExpandableTextCell` in `cells.tsx`) are a button that opens the complete
  value in an overlay anchored to the cell, and the row sheet
  (`row-peek-sheet.tsx`) stacks every property of one row at full sheet width.
- The table's own scrollport is the `div` in `table-view.tsx`, not the `Table`
  primitive's container (which is switched to `overflow-visible` through
  `containerClassName`). A sticky `thead` only sticks against the box that
  actually scrolls.

## Inline embed

A database can also appear as a live view inside another page (Notion's
"linked database view"), via the slash menu's "Datenbank einbetten" or the
`databaseEmbed` node (`packages/editor/src/database-embed.ts`). It renders the
same `DatabaseShell` the full-page view uses — filters, sorting, inline cell
edits and adding a row all work the same, and the view tabs stay in sync with
the pinned `viewId` node attribute, persisted in the page's Yjs state. See
`docs/editor-extensions.md` for why this is the one node whose interactive
rendering lives in `apps/web` (`database-embed-node-view.tsx`) instead of as
plain DOM in `packages/editor`.

An embedded database breaks out of the page's reading measure: the rule for
`.exocortex-page :is(.exocortex-database-embed)` in `globals.css` widens it to
the scroll container's width (`100cqi`, a container query on
`.exocortex-page-scroll`) on every page layout. A table at 68ch is unusable,
and forcing the whole page to `full` just for one embed would stretch the prose
around it. See `Document.layout` in `docs/architecture.md` for the page widths
themselves.

## Entities: a database whose rows are things in the world

The entity layer (issue #47) adds no model. An entity is a row in an ordinary
database — one `Document` with `type: 'COLLECTION'`, its rows `PAGE`s
underneath ([ADR-011](adr/ADR-011-databases-are-documents.md)) — and that is
the whole point: a row already has a title, a body, references, a place in the
tree and a view a person can sort, filter and prune. A typed `Entity` table
would have needed all of that built again.

Two columns are read by machinery and are therefore matched **by name**, never
by id (`ENTITY_PROPERTY_NAMES` in `@exocortex/contracts`):

| Column    | Type     | What reads it                                                                    |
| --------- | -------- | -------------------------------------------------------------------------------- |
| `Typ`     | `SELECT` | Mapped to the closed `EntityType` vocabulary by option label; unknown → `other`. |
| `Aliasse` | `TEXT`   | Comma-, semicolon- or newline-separated spellings the matcher answers to.        |

By name, because a person may delete and re-add a column in the browser and an
id stored in the settings would quietly stop matching. Everything else on the
database is free: add a `Betreiber` column, a board view by type, whatever the
list needs. `POST /api/entities/database` creates one with the two columns and
writes `entities.databaseId`; after that it is an ordinary database.

**What is not a row** is the edge from an entity to a page that talks about it.
That is `entity_mention`, a typed table written by the materialization pass, for
the same reason `memory_fact` is one: the schema is fixed, no person edits it,
and the entity profile reads it on the hot path of every recall. The matcher
lives in `packages/editor/src/entity-matching.ts` so the API and the worker
cannot disagree about which names exist.

**Relations between entities are ordinary references.** Writing `[[fpb2]]` on
the Orielle page is how somebody already says "runs on", and the reference index
(issue #33) already resolves it. `GET /api/entities/:id` reads the relations off
that index rather than off a `RELATION` column — which is also why the reserved
`RELATION` property type staying unimplemented did not block this feature.

**New names are proposed, never created.** A phrase that looks like a name,
appears at least twice on a page and on at least `entities.candidateThreshold`
separate pages becomes an `entity_candidate`. Confirming one is a call
(`exo_entity_candidate_confirm`); dismissing it is recorded, so it does not come
back the next time somebody saves a page carrying it. No model is asked at any
point: counting is deterministic, free, and gives the same answer tomorrow.

## Known limitations (deliberate, not bugs)

- **Filters/sorts sent alongside a `viewId` are ignored.** When a request to
  `rows/query` includes a `viewId`, the API resolves filters/sorts from that
  saved view and does not merge in request-level `filters`/`sorts` — the two
  are alternatives, not additive. Query without a `viewId` for one-off,
  unsaved filtering.
- **A row's property type cannot be changed once created.**
  `updateDatabasePropertyRequestSchema` only allows renaming and `config`
  changes. Changing what a column _means_ (TEXT → NUMBER, say) is
  delete-and-recreate; there is no coercion path for existing values.
- **Pagination degrades to offset-based once a view sorts or filters.** See
  ADR-011's consequences section.
- **PERSON and FILES are edited as raw, comma-separated ids** in
  `cells.tsx`'s `IdListCell` — a member picker and a file browser are a
  separate, larger feature; this is the honest minimal editor that still
  round-trips the array completely through the API.
- **A database embed's Markdown export/import loses the reference.** Markdown
  is interchange-only (ADR-007) and never carries internal ids, so the
  `:::database-embed` container round-trips only the database's title, and
  re-importing such a file produces an embed with no database picked yet.
  `pageLink` used to share this limitation and no longer does: the import path
  binds `[[Titel]]` back to a document (`bindPageLinkIdentities`, issue #14).
  The same treatment would work here and has simply not been built.
