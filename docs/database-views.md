# Database views

Notion-style typed databases: a `Document` with `type: 'COLLECTION'`, typed
`DatabaseProperty` columns, saved `DatabaseView`s (Table/Board/Gallery/Calendar)
and rows that are ordinary `Document`s (`type: 'PAGE'`) underneath it. Read
`docs/adr/ADR-011-database-rows-are-documents.md` first — this document is the
"how to extend" recipe, the ADR is the "why".

Rows being documents does not make them pages of the hierarchy. The sidebar,
the move menu and `exo_page_tree` ask the tree with `rows: 'count'`, so a
database appears there once, with its row count, and its rows live in its
views (issue #221: unfolding ten thousand rows took 18 s and 1.6 GB). The full
tree, rows included, is still what the editor's page pickers and link markers
look titles up in.

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
   `IMPLEMENTED_PROPERTY_TYPES` once the type is ready to accept writes.
   Leaving it out of that list reserves the enum value without offering it to
   anybody, which is how `RELATION`/`ROLLUP`/`FORMULA` waited for issue #76.
   If its whole meaning is in `config`, add it to `CONFIGURED_PROPERTY_TYPES`
   too, so it cannot be created half-finished.
3. Map it to a `document_property_value` column in
   `packages/database/src/database-derived.ts`'s `columnForType` (query side)
   and in `apps/api/src/databases/database-rows.service.ts`'s `toColumnData`
   /`storedToResponseValue` (write/read side). A genuinely new storage shape
   needs a new typed column on `DocumentPropertyValue`, not a JSONB
   catch-all — see ADR-011 for why.
4. Add a cell editor under `apps/web/src/components/database/` (next to
   `text-cells.tsx`, `option-cells.tsx`, `date-cell.tsx`, `relation-cell.tsx`)
   and register it in `PropertyCell`'s switch in `cells.tsx`. Add a compact,
   non-interactive rendering branch to `PropertyValueDisplay` in `cells.tsx` for Board/Gallery
   card summaries — these are two different rendering modes on purpose: a
   table cell is a form control, a card summary is read-only text, and a
   `<input type="date" readOnly>` still shows browser date-picker chrome that
   a plain formatted string does not.
5. Add its name under `propertyTypes` in the German `database` message
   namespace (`packages/i18n/src/messages/de/database.json`, read by
   `usePropertyTypeLabel` in `apps/web/src/components/database/property-types.ts`)
   and, if it should be filterable, its operators in `operatorsForType` with
   their words under `filters`.

## Dates: point in time or span

A `DATE` property answers in one of two shapes, and which one is decided by the
property's `config`, never by the individual row. `parseDatePropertyConfig`
(contracts) reads the bag with defaults, so a property created before the field
existed keeps behaving exactly as it did.

| `config` field | Effect                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `includeTime`  | The value carries a time of day. Editors switch from `DatePicker` to `DateTimePicker` (day plus `TimeInput`), and rendering shows the time on the reader's clock.                                        |
| `isRange`      | The value is a span. **This changes the response shape** of every value of that property: `false` returns the bare ISO string, `true` returns `{ start, end, allDay }` (`databaseDateRangeValueSchema`). |
| `timeZone`     | IANA zone the wall-clock parts were authored in. Stored instants are always UTC; a written date and time without `Z` or an offset is read in this zone (#255).                                           |

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

- **A written time names its zone**, or the column does (issue #255). A
  string with `Z` or an offset is that instant; a bare day (`2026-11-26`) is UTC
  midnight. A date and time with neither (`2026-11-26T12:00:00`) is read in the
  column's `config.timeZone` when it has one (`instantFromIsoInput` in
  `packages/contracts/src/zoned-time.ts`, tested over both transition nights),
  and otherwise stays what `Date` makes of it on a UTC host, which is UTC. The
  MCP tool descriptions say so, because an importer that sends noon without a
  zone otherwise lands an hour off for every reader in Berlin.

### Showing a date (issue #255)

Every stored instant stays UTC, on the wire and in SQL: filters, sorting,
formulas and rollups compute in UTC (ADR-041), and `data` on the MCP surface
is the ISO string the API answered. Only the rendering is the reader's:

- a time is shown in the zone of the reader's device (the `exocortex.tz`
  cookie on the server, the browser's own zone in the client) and on the
  reader's clock: the interface language's, or the 24- or 12-hour clock the
  account chose (`User.timeFormat`, `/einstellungen/sprache`,
  `exo_me_preferences_set`). `useFormatter` from `apps/web/src/lib/formatter.ts`
  adds that clock to every option set with a time; next-intl's own is refused
  by lint. Time is entered with `TimeInput`, never the browser's time field,
  which follows the operating system rather than the interface.
- a whole day never moves: a DATE without a time, an all-day span, and a
  rollup or formula that provably yields one (`derivedDateIsWholeDay`: a
  whole-day column, its earliest or latest, `dateAdd` of one, an `if` of two)
  are formatted in UTC. A whole-day derived value is answered as `YYYY-MM-DD`
  rather than the midnight instant, so no client can read it in the wrong
  zone.
- `exo_database_query` writes a whole day as the day in its table text and a
  time as the UTC instant; the server knows no reader's zone to say more.

An all-day value is a _floating_ calendar date stored as UTC midnight. Read it
off the ISO string; converting it into the viewer's zone shifts every birthday a
day for anyone west of Greenwich. A timed value is a real instant and belongs in
the day the _viewer_ sees it in. `dayKeyOf` in
`apps/web/src/components/database/calendar/entries.ts` is the one place that
decision lives.

### The five calendar modes

A CALENDAR view draws one of five projections of the same rows, chosen with
`config.calendarMode` (`LIST`, `DAY`, `WEEK`, `MONTH`, `YEAR`, default `MONTH`).
They are modes rather than view types on purpose: all five read one
`datePropertyId` and one saved filter set, and differ only in the window they
ask for and how they lay the answer out. The field lives on the view, not in the
browser, so the choice survives a reload on another device and an agent reaches
it through `exo_database_view_update` like any other view setting (ADR-025).

The files are all under `apps/web/src/components/database/calendar/`:

| File                 | Responsibility                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `range.ts`           | The window per mode, the step of the arrows, the period label. Pure, local-time date arithmetic; the one file with a test for every mode. |
| `entries.ts`         | Rows to `CalendarEntry`s and the day bucket each covers, including the all-day rule above.                                                |
| `layout.ts`          | Overlapping appointments side by side on a time axis: wall-clock minutes, greedy column packing per overlap cluster.                      |
| `time-grid-view.tsx` | Day and week. One column per day, all-day entries in a band above the axis, a line on the current minute.                                 |
| `month-view.tsx`     | The six-week grid, three entries per cell, the rest behind "+N weitere" into the day view.                                                |
| `year-view.tsx`      | Twelve mini grids; a day carries how busy it was, because a title is unreadable at that size.                                             |
| `agenda-view.tsx`    | The list: only the days of the month that have something on them.                                                                         |

Two consequences worth knowing before changing any of it:

- **The window is a server-side filter, not a client-side one.** The view asks
  through `useDatabaseCalendarRows`, which sends the mode's window as an
  `overlaps` condition _alongside_ the view's saved filters and follows the
  cursor to the end (up to ten pages). A calendar cannot page: a year view that
  showed the first hundred rows and stopped would be wrong rather than
  incomplete, because the reader cannot tell which day lost its entries. When
  the page cap is hit, the view says so instead of truncating silently.
- **Inline filters narrow a saved view, they never replace it.**
  `resolveFiltersAndSorts` in `database-rows.service.ts` nests both groups under
  one `and`. The other way round, a client that named a view could read the rows
  the view was set up to hide.

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
   requesting more throws `validation_failed`. A view that cannot be honest
   about showing only the first hundred rows narrows the query instead and
   follows `nextCursor`, the way `useDatabaseCalendarRows` does.
3. Wire it into `database-shell.tsx`'s per-type dispatch and into
   `view-tabs.tsx`'s `VIEW_TYPE_LABELS`/`VIEW_TYPE_ICONS`/`VIEW_TYPES` so the
   "+" menu can create one.
4. If the view needs extra per-view configuration (Calendar's
   `datePropertyId` and `calendarMode`, Gallery's `coverPropertyId`), add it to
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
| `rowHeight`         | `short`/`medium`/`tall` = 1/3/6 lines per cell. A clamp, never a data limit: the full value is always reachable in the cell overlay and in the row's page header (also in the side panel).                        |
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
  (`ExpandableTextCell` in `text-cells.tsx`) are a button that opens the complete
  value in an overlay anchored to the cell, and a row's page header, in the
  side panel or on the row's own page, stacks every property of one row at
  full width.
- The table's own scrollport is the `div` in `table-view.tsx`, not the `Table`
  primitive's container (which is switched to `overflow-visible` through
  `containerClassName`). A sticky `thead` only sticks against the box that
  actually scrolls.

The grid is drawn by the cells themselves, as a right and a bottom border on
every cell except the trailing one (issue #305). The table stays
`border-separate`, because with `border-collapse` a shared border belongs to
whichever cell wins it, and under the pinned title column that is often the
cell scrolling away. Every line is a real border, never a 1px background box:
a browser rounds a border's width to whole device pixels but only a box's
edges, so at 150 % zoom a line drawn as a box came out twice as thick as its
neighbours. The pinned title cell is opaque in every state, hover and an open
cell menu included, with the row's tint mixed into the page colour, because
the columns scroll underneath it.

## A row's page header

A row opened as a page shows its values under its title (issue #254,
`row-properties-header.tsx`, mounted in `document-view.tsx` for a `PAGE` whose
parent is a `COLLECTION`, or whose parent a share hides; `rowCollectionIdOf`
decides, and for a shared page the row read's `row: null` is what says it is
no row). It is the second place a row is edited, beside the table cell, and
the side panel shows this same header (see "A row beside its database"
below). Like the cell it is not a copy:

- **One read, one write.** The header reads `GET /api/documents/:id/row`, which
  answers the row _and_ the columns of its database (`DocumentRowResponse.properties`,
  in the database's order), and writes `PATCH /api/documents/:id/values`, the
  same route the table writes. Nothing goes into the page's Yjs state. The
  columns ride along with the row because a page can be shared on its own
  (ADR-044): the reader may read the row and not its database, and a value
  without its column's name, type and options cannot be read (`docs/sharing.md`).
- **One editor per type.** Every value is the table's `PropertyCell`, at the
  `tall` clamp: dates with `DatePicker`/`TimeInput` (#255), selections with
  their badges, relations with their picker, rollups and formulas read-only
  through `ReadonlyCell` (ADR-041), files with `FilesCell` (see "Files in a
  FILES cell" below). PERSON is the table's raw id editor, see the limitation
  below.
- **Folding.** `layoutRowHeader` (`row-header-layout.ts`, unit-tested) decides
  what shows before "N weitere Eigenschaften": up to eight columns are shown
  whole to an editor; past that the first six and every filled one, at most
  twelve, always in the database's order; a reader without write access sees
  only filled values, because an empty field they cannot fill says nothing. A
  fold that would hide one line shows it instead. Whether it is unfolded is
  remembered per database in the browser (`exocortex.rowHeader.expanded.<id>`).
  Notion's per-column "hide when empty" is deliberately not a schema setting
  here: it would be one decision for every reader of the database, and the
  rule above already folds exactly the empty tail.
- **Live.** `useDatabaseRealtime` (`apps/web/src/components/shell/database-realtime.ts`)
  answers `database.row.updated`, `database.property.changed` and
  `database.view.changed` by invalidating the database's rows, its columns or
  views and every cached single row, so an edit in the table reaches an open
  row page and the other way round, across tabs, members and agents. The row
  queries are invalidated across the board rather than by id because a rollup
  on one row is computed from rows of another database.

The context panel's "Eigenschaften" tab reads the same answer, so it too shows
the values on a page shared on its own.

## Acting on rows: the handle and the selection

A table row starts with a checkbox and a handle (issue #244), the table's
counterpart of a block's six dots in the editor. Both wait for the pointer:
hidden until the row is hovered or one of them has focus, shown on every row
while any row is selected, and always on a coarse pointer, where nothing
hovers. They sit inside the pinned title cell rather than in a column of their
own, so the grid lines of #305 and the pinned cell's tint are unchanged.

- **The handle's menu** (`row-handle.tsx`): open in the side panel, open as a page,
  copy link, and for a writer duplicate, move and into the trash. It does not
  drag: a table's order is its view's sort and rows have no manual order to
  drag into. "Verschieben" is `RowMoveDialog`, a search over the workspace
  that ends in `useGuardedMove`, the same move the palette makes, share
  warning included; the row stops being a row of this database when it lands
  elsewhere, and its stored values stay behind unread.
- **The selection** (`row-selection.ts`, unit-tested; `use-row-actions.tsx`
  holds it): a click on a checkbox flips that row and makes it the anchor,
  Shift with a click gives every row between the anchor and this one the same
  state, the header checkbox takes every row shown, and Escape lets go unless
  a field, a menu or a dialog takes the key. A click in any other cell still
  edits the cell. Only rows still shown count, so a row another tab put in the
  trash drops out of the selection by itself; switching to another view starts
  empty.
- **The bar** (`row-selection-bar.tsx`) replaces nothing: it appears above the
  table while rows are selected. "Eigenschaft setzen" opens the column's own
  `PropertyCell` in a dialog, seeded with the value the rows share, and every
  change goes to all selected rows at once; computed columns and FILES are not
  offered, because a file belongs to the row it was uploaded onto (ADR-098).
  "In den Papierkorb" asks first when more than one row goes.
- **Three batch routes, each one request.** `PATCH /api/documents/:id/rows/values`
  (`updateMany` in `DatabaseRowsService`), `POST .../rows/trash` and
  `POST .../rows/duplicate` (`DatabaseRowActionsService`), at most
  `DATABASE_ROW_BATCH_MAX` (100) rows. Every row is checked before any changes:
  that it is a live row of this database (`database_rows_not_found` names the
  ones that are not) and that the caller may edit it -- for a copy, read it and
  create in the database -- each on its own access context, because a share can
  reach one row and not its neighbour (ADR-044). Values are written in one
  transaction with one `database.row.updated` outbox event per row, so a rule
  reacts to a row as before. The trash is `DocumentsService.archive` per row,
  so each row comes back on its own, from the trash like any page; there is
  no undo of its own. A copy is made like a page from a template (ADR-039):
  from the canonical Yjs state with new block ids, title, icon, cover and the
  stored values, placed directly after its row; files it names stay the source
  row's.
- **Live.** Rows are pages, so a row created, duplicated, archived, restored
  or moved elsewhere arrives as a `document.*` event naming its parent, and
  `useDatabaseRealtime` invalidates that parent's rows. Before #244 a table
  learnt about such a row only on its own next fetch.
- **The palette** (`palette/row-selection-commands.tsx`), on the full-page
  database only: "Alle Zeilen auswählen", and while rows are selected
  "Eigenschaft für N Zeilen setzen → Spalte", duplicate, trash and "Auswahl
  aufheben".
- **Board, gallery, calendar.** A board card's existing menu also duplicates,
  copies the link and puts the card in the trash. Selecting several cards is
  the table's: a gallery card is one link from edge to edge and a calendar
  entry is a small chip, so neither has room for a checkbox that would not
  fight the click that opens the row. Their rows are selected in a table view
  of the same database.

## A row beside its database: the side panel

Issue #239, Notion's "side peek". The arrow beside a row's name, "Öffnen" in
the handle menu, a click on a board card, a gallery card or a calendar entry,
and every row made by "Neue Zeile" or "Neue Karte" open the row in a panel
over the right-hand part of the page area (`row-peek-panel.tsx`). A click with
Strg, Cmd, Shift or the middle button still goes to the row's own page
(`RowPeekLink`); the title link in a table row also stays a link to the page.

- **The panel is the page.** Its content is `PageSurface`
  (`components/shell/page-surface.tsx`), the same component `DocumentView`
  renders for every page: title, the row's page header, the overview and the
  collaborative editor. Nothing is a second implementation. It reports into a
  `DocumentSessionProvider` of its own, so the header's presence, save and
  connection state keep describing the page underneath, and the panel shows
  its own save indicator. Its title does not answer the palette's "Seite
  umbenennen", which stays with the page the address names.
- **The open row is the address.** `?p=<rowId>` (`row-peek-address.ts`,
  unit-tested), written with `window.history.pushState`/`replaceState`, which
  Next.js folds into `useSearchParams` without a server round trip. Opening
  pushes a step, switching rows replaces it, closing goes back when the panel
  pushed that step and replaces otherwise; so Back closes the panel, a reload
  or a shared link opens the same row, and `?p=` naming the page itself is
  ignored. `RowPeekProvider` sits in `DocumentView`, so an embedded database
  opens its rows beside the page it is embedded in.
- **The table is not touched.** The panel lies over the table rather than
  pushing it aside, and nothing about the table depends on the address, so its
  filters, sort, selection (#244) and scroll position stay as they were through
  opening, switching and closing. Its width is `clamp(26rem, 48%, 44rem)` of
  the page area, capped at the whole of it, which is what a phone gets. The
  context panel and the AI chat stay beside it and keep speaking about the page
  the address names.
- **Switching keeps the text.** Each row is its own Yjs document; switching
  tears the old connection down the way leaving a page does, after the edits
  went to the socket and the browser's offline copy. A title being typed is
  committed by blurring it before the panel closes on Escape.
- **Keyboard.** Opening moves the focus into the panel; a new row's title is
  focused and selected once, so the first keystroke names it. Escape closes the
  panel unless a menu, popover or dialog is open or a field outside the panel
  has the focus; while the panel is open the table's own Escape (letting go of
  the selection) waits for the next press. Closing returns the focus to the
  opener of the row shown last. The palette offers "Seitenleiste schließen"
  and "Offene Zeile als ganze Seite öffnen" while the panel is open
  (`palette/row-peek-commands.tsx`).
- **Live.** A row renamed in the panel reaches the table beside it at once,
  and `useDatabaseRealtime` now also answers `document.updated` by invalidating
  the parent's rows, so a rename elsewhere reaches an open table too.
- **No MCP counterpart.** The panel is a way of looking at a page, not a
  capability: an agent reads and writes the same row with `exo_page_read`,
  `exo_database_row_get` and the page and row writes it already has.

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
that index rather than off a `RELATION` column, and that is still true now that
the column exists: a `[[…]]` in prose and a relation column answer different
questions, and an entity profile is built from what people wrote, not from a
schema somebody has to maintain.

**New names are proposed, never created.** A phrase that looks like a name,
appears at least twice on a page and on at least `entities.candidateThreshold`
separate pages becomes an `entity_candidate`. Confirming one is a call
(`exo_entity_candidate_confirm`); dismissing it is recorded, so it does not come
back the next time somebody saves a page carrying it. No model is asked at any
point: counting is deterministic, free, and gives the same answer tomorrow.

## Linked and computed columns

Three property types do not hold a value of their own (issue #76, ADR-041).

**RELATION** stores a list of row ids in `jsonValue`, the same shape
`MULTI_SELECT`, `PERSON` and `FILES` use, which is why `contains`,
`not_contains`, `is_empty` and `is_not_empty` work on it with no new operator.
Its `config` is `{ targetCollectionId, allowMultiple }`. The target has to be a
database in the same workspace — a self-relation is allowed, and is how a task
gets sub-tasks. Every id written is checked to be a live row of that database,
because a dangling link is invisible in the table and only surfaces later as a
rollup that quietly counts wrong.

Values are ids and never titles. A client that shows names fetched them through
an authorized read of the target database, so somebody who may not open it sees
the bare id rather than a name nobody showed them.

**ROLLUP** aggregates over a relation. Its `config` is
`{ relationPropertyId, targetPropertyId, aggregate }`, with nine aggregates:
`count` (needs no target), `count_unique`, `count_not_empty`, `sum`, `average`,
`min`, `max`, `earliest`, `latest`. An empty `sum` is `0`; every other
aggregate over no rows is empty, because "no earliest date" is not a date. An
archived linked row drops out of the aggregate but keeps its link, so restoring
it brings its contribution back.

A rollup's target must be a plain column — not another rollup, not a formula,
not a relation. That rule is what bounds how much schema computing a cell
needs: its own database plus one hop, which is all `loadDatabaseScope` loads.

**FORMULA** carries `{ expression }` in the language of
`packages/contracts/src/database-formula.ts`:

|            |                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Columns    | `prop("Name")`, by column name or by column id                                                                                       |
| Types      | number, text, boolean, date                                                                                                          |
| Operators  | `+ - * / %`, `== != < <= > >=`, `and`, `or`, unary `-`                                                                               |
| Precedence | `or` < `and` < `== !=` < comparison < `+ -` < `* / %` < unary                                                                        |
| Functions  | `if not and or empty format concat length upper lower contains abs floor ceil round min max now dateAdd dateDiffDays year month day` |
| Separators | `;` and `,` both work                                                                                                                |

A formula may read another formula and a rollup of the same database; a cycle
is refused, at a depth of at most `MAX_DERIVED_DEPTH`. Division is compiled
with `NULLIF`, so dividing by zero is an empty cell rather than a failed query.
An unchecked checkbox reads as `false`, not as unknown.

**All three are computed in SQL on every read**, never stored (ADR-041). The
compiled expression is used in the `SELECT`, in a `WHERE` that filters on the
column and in the `ORDER BY` that sorts by it, which is the reason a computed
column can be filtered and sorted at all. Writing to a rollup or a formula is
refused; the way to change one is to change the linked rows or the expression.

**A configuration that cannot be computed is refused when it is written.**
Creating, changing or deleting a property re-compiles every derived column of
the database first, so deleting a column a formula reads fails with
`database_property_in_use` rather than leaving a table that will not render.
The refusal carries the problem as a code, not a sentence:
`details.formula` holds `{ code, args, propertyId, propertyName }` (codes in
`FORMULA_ERROR_CODES`, `packages/contracts/src/database-formula.ts`), and
`details.reason` the bare code for an agent. The property editor words it in
the reader's language and checks the syntax locally while the formula is
typed.
Renaming is the one case that gets help instead of a refusal: the formulas of
that database are rewritten through the tokenizer in the same transaction, so
`prop("Preis")` follows the column it names — and a string literal that merely
happens to read `"Preis"` is left alone.

## Files in a FILES cell

Issue #245, [ADR-098](adr/ADR-098-a-cell-file-hangs-on-its-row.md). A FILES
value is a list of attachment ids; `FilesCell`
(`apps/web/src/components/database/files-cell.tsx`) is the one editor for it,
in the table, a row's page header (on its page and in the side panel) and the
properties panel, because all three render `PropertyCell` and pass it the row.

- **The upload names the cell.** The ordinary upload route
  (`POST /api/workspaces/:id/attachments`) takes a `propertyId` form field
  beside `documentId` (the row); the URL upload and the upload ticket take it
  in their bodies. `CellFilesService` (`apps/api/src/attachments`) checks that
  the column is a FILES column of the row's database and that the caller may
  edit the row, the upload stores the file on the row's page with
  `Attachment.propertyId` set, and `appendPropertyFile` appends it to the value
  under a transaction-scoped advisory lock, with the `database.row.updated`
  outbox row and realtime event a value write carries. The browser never writes
  the list after an upload, so two files dropped at once cannot race.
- **Writing the list.** `PATCH /api/documents/:id/values` still takes the whole
  list, which is how a file is removed or the order changed. Ids are kept once,
  and an id the cell does not already hold must be a file on this row
  (`database_files_foreign` otherwise); ids it holds may stay even if they hang
  elsewhere, which is what a row made from a template holds (ADR-039).
- **Reading the names.** Every row answer (`rows/query`, `/row`, a value write)
  carries `files`: id, name, type and size of each file its FILES values name,
  once. An id without an entry is a file that is gone; the cell says so and
  offers to remove it. Board and gallery print the names, and the gallery's
  cover is the first picture among the cover column's files.
- **Who cleans up.** Deleting the row for good deletes its files with it, like
  any page's. A file whose column no longer names it -- removed from the cell,
  left by a deleted column, or uploaded by a request whose value write failed --
  is collected by `collect-orphaned-covers` one day later
  (`findUnreferencedPropertyFiles`); a file only on the page, without the mark,
  is never collected.
- **The target is said out loud.** Drag, drop and paste are native listeners on
  the cell, so a table embedded in a page stops the event before the editor
  puts the file into the page's text; while files are dragged over it, the cell
  is outlined and names its column. Without the right to edit, the cell only
  shows and downloads.

## Columns the AI fills

Issue #237, [ADR-099](adr/ADR-099-an-ai-column-is-a-stored-value-a-batch-is-a-run.md).
A writable column (Text, Number, Select, Multi-select, Date, Checkbox, URL,
E-mail, Phone, Person; `AI_FILLABLE_PROPERTY_TYPES`) can carry an AI
instruction, and its cells are then filled by a model from what each row holds.
The value is an ordinary stored value, never a formula (ADR-041).

- **The instruction.** `database_property_ai`, one row per column, written with
  `PATCH /api/documents/:id/properties/:propertyId/ai` (and removed with
  `DELETE`) by whoever may change the columns. A preset (`summary`,
  `key_points`, `tags`, `translate`, `document_date`, `sender`, `recipient`)
  or `custom` with the person's own words; which presets fit which type is
  `AI_FILL_PRESET_TYPES`, and `aiFillConfigProblems` is the one check the API
  refuses with and the browser warns with. `allowNewOptions` (selects only),
  the three sources (`useContent`, `useProperties`, `useAttachments`) and
  `autoFill` (`off` by default). Every property answer carries it as `ai`.
- **A batch.** `POST /api/documents/:id/ai-fills` with `propertyId`, optional
  `rowIds` (absent: the whole column, in the database's order, skipping rows
  the requester may not change) and `mode` (`empty_only`, `replace_ai`,
  `replace_all`); `dryRun` only counts. `AiFillService` writes the `ai_run`
  (kind FILL), its `database_ai_fill_run` and one `database_ai_fill_cell` per
  row in one transaction and queues `database-ai-fill`; at most
  `ai.fillMaxRowsPerRun` cells, and the answer says how many rows were left
  out and why. `GET /api/documents/:id/ai-fills`, `GET /api/ai-fills/:id`,
  `POST /api/ai-fills/:id/cancel` and `/retry` are the rest of the loop.
- **One cell.** The worker asks `AiFillWorkerService` for the cell's material
  (title, other values as text, the page's Markdown up to 20 000 characters,
  up to ten files with their text, members for a Person column), calls the
  model once without tools, and posts the answer back.
  `coerceAiFillAnswer` (`packages/contracts/src/database-ai-fill.ts`) turns it
  into the column's value or a code; `writeAiValue` on `DatabaseRowsService`
  writes it like any value, with `aiRunId` set. The mode is checked again
  before the model is asked and when the answer arrives, so a value typed in
  the meantime is kept.
- **Marks.** `document_property_value.aiRunId` is cleared by every other
  write. Every row answer carries `aiCells` (`aiCellsOfRows` in
  `apps/api/src/databases/ai-fill/ai-cells.ts`): `pending`, `failed` with its
  code, `empty`, or `filled` with the time, for the table to draw.
- **In the browser.** `apps/web/src/components/database/ai-fill.tsx`.
  `useAiFillControls` holds the two dialogs the column menu, a cell, the
  selection bar and the palette all open: the instruction (preset, own words,
  sources, new options, automatic filling; `aiFillConfigProblems` disables
  saving) and the confirmation before a batch, whose count is a `dryRun` of
  the same request in the chosen mode. `AiCellMark` draws a cell's mark in its
  corner (AI value with time, pending, failed with the reason, nothing found)
  and offers an empty cell of a configured column on hover; pressing it fills
  that one cell in `replace_ai`, so it never overwrites a person's value.
  `AiFillProgress` is the strip above the table for every batch still working,
  with its cancel; `database.ai_fill.changed` invalidates it and the rows, and
  it polls every five seconds while a batch is open in case an event is missed.
  The palette offers "fill column" and, with a selection, "fill selection"
  (`row-selection-commands.tsx`).

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
- **PERSON is edited as raw, comma-separated ids** in `text-cells.tsx`'s
  `IdListCell`, in the table and a row's page header alike — a
  member picker is a separate, larger feature; this is the honest minimal
  editor that still round-trips the array completely through the API. FILES
  has had its own cell since issue #245.
- **A database embed's Markdown export/import loses the reference.** Markdown
  is interchange-only (ADR-007) and never carries internal ids, so the
  `:::database-embed` container round-trips only the database's title, and
  re-importing such a file produces an embed with no database picked yet.
  `pageLink` used to share this limitation and no longer does: the import path
  binds `[[Titel]]` back to a document (`bindPageLinkIdentities`, issue #14).
  The same treatment would work here and has simply not been built.
