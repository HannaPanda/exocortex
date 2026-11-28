# Editor extensions

`packages/editor` owns the canonical document schema. React components must never
define schema-relevant Tiptap extensions.

## The contract

```ts
export interface ExocortexEditorExtension {
  name: string;
  schemaVersion: number;
  extensions: Extensions; // Tiptap nodes/marks/plugins
  markdown?: MarkdownExtensionAdapter; // serializers, token and container handlers
  plainText?: PlainTextAdapter; // search projection
  migrations?: DocumentMigration[]; // stored-document upgrades
  blocks?: BlockCatalogEntry[]; // slash menu, turn-into, block menu
}
```

The registry is `EXOCORTEX_EDITOR_EXTENSIONS` in
`packages/editor/src/extensions.ts`. `buildEditorExtensions()` flattens it for
Tiptap, `buildMarkdownRegistry()` and `buildPlainTextRegistry()` merge the adapters,
`collectMigrations()` collects migrations, `buildBlockCatalog()` collects the
insertable blocks.

Current units: `core-structure`, `core-marks`, `inline-styling`, `mention`,
`lists`, `toggle`, `collapsible-heading`, `columns`, `mathematics`,
`table-of-contents`, `page-link`, `breadcrumb`, `tables`, `media`, `media-blocks`,
`embed`, `callout`, `database-embed`, `saved-query-embed`, `transclusion`,
`block-id`.

## Supported nodes and marks

Nodes: `doc`, `paragraph`, `heading` (1–6), `text`, `codeBlock`, `blockquote`,
`bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `horizontalRule`,
`hardBreak`, `image`, `table`, `tableRow`, `tableHeader`, `tableCell`, `callout`,
`details` / `detailsSummary` / `detailsContent`, `columnList` / `column`,
`inlineMath` / `blockMath`, `tableOfContents`, `pageLink`, `breadcrumb`, `mention`,
`fileAttachment`, `video`, `audio`, `pdf`, `embed`, `bookmark`, `databaseEmbed`,
`savedQueryEmbed`, `transclusion`.

Marks: `bold`, `italic`, `strike`, `code`, `link` (including the internal `wiki:`
scheme), `underline`, `superscript`, `subscript`, `textColor`.

Asserted by `packages/editor/src/schema.test.ts`.

## The block catalog

`packages/editor/src/block-catalog.ts` describes every block a writer can insert or
convert into: a German label and description, search keywords, a group, an icon
_name_ and a `run(editor, value?)`.

One list, three consumers — the slash menu, the "Umwandeln in" menu and the block
action menu. Adding a block means adding one catalog entry next to its extension;
it then appears in all three. The catalog names its icon instead of importing one,
because `packages/editor` has to stay renderer-free for headless use on the server;
`apps/web/src/components/editor/block-icon.tsx` resolves the names.

An entry that needs more than the editor declares it with `prompt`:
`'url'`, `'file'`, `'page'`, `'database'`, `'saved-query'` or `'latex'`. The web layer collects the value
(`block-prompt.tsx`, including the attachment upload) and passes it into `run`.

## Editor UI

All of it lives in `apps/web/src/components/editor` and contributes **no** schema:

| File                            | Purpose                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `selection-toolbar.tsx`         | formatting bar over a selection                                                                                                                                                                                                       |
| `turn-into-menu.tsx`            | convert the selected block, or the handle's block (issue #229)                                                                                                                                                                        |
| `color-menu.tsx`                | text and background colour of the selection, or of the handle's whole block                                                                                                                                                           |
| `link-menu.tsx`                 | link editor: understands `[[Seite]]`, and searches the workspace's pages for anything that does not look like an address                                                                                                              |
| `link-bubble.tsx`               | bubble menu over the caret inside a link: open, edit, remove                                                                                                                                                                          |
| `follow-link-context.tsx`       | ref bridge that hands `EditorSurface`'s click handler and the `pageLink` node view a `follow` function without either holding it as state                                                                                             |
| `link-navigation.tsx`           | `useLinkNavigation`: what following a resolved link _does_ (new tab, router push, `wiki:` lookup plus its ambiguous/missing/error dialogs)                                                                                            |
| `emoji-menu.tsx`                | emoji picker (inserts characters)                                                                                                                                                                                                     |
| `slash-menu.tsx`                | `/` block menu, reads the catalog                                                                                                                                                                                                     |
| `mention-menu.tsx`              | `@` menu for pages, people and dates                                                                                                                                                                                                  |
| `block-handle.tsx`              | drag handle in the outer lane of the interaction gutter (docs/ui-system.md, and docs/deviations.md 17)                                                                                                                                |
| `handle-hover.ts`               | which block the handle belongs to while the pointer moves: a nested block keeps it over its text and on the way to the handle (issue #286)                                                                                            |
| `block-actions.tsx`             | turn into, colour, move, duplicate, copy link, delete — shared by handle and toolbar; a delete that loses a whole structure is confirmed first and re-finds its block by id afterwards                                                |
| `block-target.ts`               | the block a handle action is aimed at: found again by its id, then selected with `runOnBlock` before the selection command runs (issue #229)                                                                                          |
| `block-removal.ts`              | which blocks are worth a confirmation (compound ones, and anything above 280 characters) and what the dialog says about them (issue #91)                                                                                              |
| `destructive-confirm.tsx`       | the confirmation dialog itself. Rendered by `EditorChrome` and reached through a context, because every caller is a bubble menu or a drag handle that unmounts as soon as the text loses focus                                        |
| `suggestion-menu.tsx`           | shared state-driven machinery for `/` and `@`, including where the popup goes and how far its list may grow                                                                                                                           |
| `callout-menu.tsx`              | symbol, heading and frame colour of a callout, opened from its symbol or heading, or with `Tab` from its text (issue #306)                                                                                                            |
| `code-block-toolbar.tsx`        | language picker and copy, in the block's top right corner while the pointer rests on it or the caret is in it, one `Tab` stop after the text (issue #304)                                                                             |
| `table-toolbar.tsx`             | rows, columns, header, merge, and the confirmed "Tabelle löschen"                                                                                                                                                                     |
| `block-prompt.tsx`              | value and file collection for catalog entries                                                                                                                                                                                         |
| `comment-markers.tsx`           | ProseMirror **decorations** on the blocks that carry an open comment thread, plus the two-way wiring to the Kommentare panel. Never a mark: a comment is not document content, so it must leave no trace in the Yjs state (issue #18) |
| `page-link-node-view.tsx`       | React node view for `pageLink`, see the exception below                                                                                                                                                                               |
| `page-link-context.tsx`         | ref bridge that lets the `pageLink` node view reopen the page picker, so a placed link can be re-targeted                                                                                                                             |
| `saved-query-embed-context.tsx` | the same ref bridge for the query block, so "Suche wechseln" reaches the picker (issue #74)                                                                                                                                           |
| `transclusion-node-view.tsx`    | React node view for `transclusion`: the header, the five states a reference can be in, and the read-only editor that renders the fragment (issue #78)                                                                                 |

Node views that render _inside_ the document (table of contents, breadcrumb, media,
the callout) live in `packages/editor` and are plain DOM, not React, so
`getExocortexSchema()` keeps working without a DOM on the server.

The callout (issue #306) is the reference for such a node view with editable
content and controls of its own around it. Its symbol is a `button` and its
heading a pressable label, both outside `contentDOM`; `stopEvent` keeps
ProseMirror from placing a caret on a press there and `ignoreMutation` from
reading their DOM. A press sends `CALLOUT_EDIT_EVENT` with the callout's
position and the symbol as anchor, and `callout-menu.tsx` opens the React menu
against it, because the menu needs the design system and the emoji palette.
A change of symbol, heading or colour is painted in place (`update` returns
`true` when nothing else changed), so the anchor survives the change the menu
makes. From the keyboard, `Tab` in a callout's text focuses its symbol (the
same contract as the code block's bar), `Enter` opens the menu, `Escape` and
`Shift + Tab` go back to the text. The symbol's accessible name says which
symbol it is (`EditorWords.callout.edit`), because the symbol carries the
box's meaning.

**Four exceptions:** `databaseEmbed` (`database-embed.ts`), `pageLink`
(`page-link.ts`), `savedQueryEmbed` (`saved-query-embed.ts`) and `transclusion`
(`transclusion.ts`). Their schema (attributes, `parseHTML`/`renderHTML`, Markdown
adapter) lives in `packages/editor` like every other node, but each declares
no `addNodeView()` — the interactive rendering is a real React node view
supplied entirely by `apps/web`, handed to `buildEditorExtensions()` through
its `nodeViews` option in `collaborative-editor.tsx`.

The option is the whole mechanism, and passing `Node.extend({ addNodeView })`
through `additionalExtensions` instead is the mistake it exists to prevent:
Tiptap does not deduplicate, so the node was registered twice. It warned about
the duplicate name, built the schema from whichever copy came last, and ran
both copies' input rules, keyboard shortcuts and ProseMirror plugins (issue
#114). `nodeViews` applies the renderer to the one canonical instance, the same
way `mediaInfo` is applied.

For `databaseEmbed` that is a live `DatabaseShell`, the same component the
full-page database view uses: reusing it outweighs hand-building filters,
inline cell editing and four view layouts again in plain DOM.

For `savedQueryEmbed` (`saved-query-node-view.tsx`, issue #74) it is the answer
to a stored question. The node holds the saved query's id, the name it had when
it was inserted and a row limit; the hits are fetched when the block renders
and are deliberately never written into the document, because a written answer
is a copy that rots.

For `transclusion` (`transclusion-node-view.tsx`, issue #78, ADR-045) it is
content the document does not own. The node stores `documentId`, `label` and
`sourceBlockId`; what it shows is fetched from
`GET /api/documents/:id/fragment` when somebody looks, as that reader, so the
source's permissions decide what appears. The fragment is rendered by a second,
**read-only editor over the canonical schema** rather than by a Markdown
renderer, because anything that re-derived it would be a second rendering of
one document: a checklist has to stay a checklist. A transclusion inside the
fragment is left as the plain block the schema renders and is never resolved
further -- one level is what makes a cycle impossible instead of detectable.

Note the attribute name: `sourceBlockId`, not `blockId`. Every addressable node
already carries `blockId` (`block-id.ts`), which says where _this_ block lives;
`sourceBlockId` says which block it shows. A node attribute that collides with
a global one is silently overwritten.

For `pageLink` (`page-link-node-view.tsx`) it is the block's _resolution
state_: whether the reference resolves to one page, several, or none, and that
page's icon, current title and archived status. A plain anchor cannot say any
of that without a network request, and knowing which page a reference resolves
to is application knowledge, not schema knowledge. The _rule_ it follows is
pure and lives in the package (`resolvePageLinkTarget`); only the lookup is
here. The click itself is handled the same way for both: neither node view
calls `stopPropagation` as a guard against the editor-wide click handler
(`followFromEvent` in `collaborative-editor.tsx`, described below), because
React's event system sits above ProseMirror's `view.dom` listener and would
run too late. The guard is the `[data-page-link]` attribute the click handler
checks for instead.

New interactive embeds should follow this pattern (schema-only node in
`packages/editor`, a `nodeViews` entry in `apps/web`) rather than inventing
another mechanism.

Two rules hold for this layer, both learned the hard way (docs/deviations.md 16–17):

- **the component that owns `useEditor` must hold no state.** Tiptap re-applies its
  options after every render of that component, which makes ProseMirror rebuild
  every plugin view; anything stateful belongs in `EditorChrome`.
- **suggestion menus render from the plugin state**, never from the suggestion
  renderer's `onStart`/`onExit`, because those do not survive a plugin-view rebuild.

A suggestion popup (`/`, `@`) is placed by `SuggestionPopup` with the same
`@floating-ui/dom` the block handle uses (issue #236): below the typed
character when the list fits, above it when that side has more room, and never
taller than the side it lands on, published as `--available-height` and read by
the list's `max-h`. That matters on a page shorter than the window, which has
nothing to scroll, and on a phone whose on-screen keyboard shrinks the visual
viewport (listened to separately, because the window is not resized). The
arrow keys move a highlight while the focus stays in the editor, so
`useActiveOptionInView` scrolls the list, and only the list, to keep the
highlighted option visible. A new suggestion menu uses both rather than a
fixed position of its own.

## Stable block identifiers

Every addressable block carries a `blockId` attribute (rendered as
`data-block-id`). `ADDRESSABLE_BLOCK_TYPES` lists them. A node that stands at
the top level of a document belongs on that list, whatever it is called
elsewhere: an image is a block here (`Image.configure({ inline: false })`), and
while it was treated as inline it was a block nothing could name, so a section
ending in a picture could not be moved at all.

The `BlockId` extension:

- assigns an id to every newly created block,
- preserves ids while editing, during collaboration and during Markdown import,
- detects duplicates (copy/paste, concurrent edits, malformed import) and
  re-assigns the later occurrence,
- uses `keepOnSplit: false`, so splitting a paragraph produces a _new_ id instead of
  a duplicate,
- appends its assignment as an ordinary transaction, marked `preventUpdate` but
  **not** `addToHistory: false`.

That last point is a trap worth stating, because the obvious flag is the wrong
one (issue #91). Under Yjs, `addToHistory` does not mark one transaction:
`ySyncPlugin` reads it from the last transaction of a dispatch and applies it to
the whole document diff it then writes into the Yjs document, and the undo
manager skips what is marked. Since this plugin appends exactly when a block was
created, setting the flag erased the _user's_ change from the undo stack —
inserting a table, and deleting one, could not be undone at all, while typing,
which creates no block, could. Nothing in the type system or the tests catches
it; the guard is in `block-id.test.ts` plus the browser test in
`e2e/tests/editor.spec.ts`.

Identity is **never** derived from document offsets, Markdown line numbers or array
indexes.

Covered by `block-id.test.ts` (jsdom, 11 tests) including split, duplicate repair,
the undo history and an HTML round trip.

## Select all, one block at a time

`Strg+A` widens step by step (`scoped-select-all.ts`, issue #261): the first
press selects the text of the innermost code block, table cell, table header,
callout or quote the caret is in, the next press the block around it, and only
then does Tiptap's own `selectAll` take the page. Before this, `Strg+A` in a
code block selected the whole page and the next keystroke replaced it. A plain
paragraph is not a scope, so `Strg+A` in running text still means the page.

The extension is behaviour only and has no schema; it sits in the registry
(`scoped-select-all`) so every editor built from `buildEditorExtensions()` has
it, and it runs ahead of the core keymap by priority. An empty block covers no
text, so the plugin remembers which block the last press selected; otherwise the
first press in an empty code block would fall through to the page. Adding a node
to `SELECT_ALL_SCOPE_NODES` is the whole change for a new block with text of
its own. Covered by `scoped-select-all.test.ts` and, for cutting and the Yjs
undo, by the browser test in `e2e/tests/editor.spec.ts`.

## Selecting with Shift and the arrow keys

`Shift+Pfeil` is the browser's own text selection, and stays that way wherever
the browser gets it right: inside a paragraph, across lists, quotes, callouts
and code blocks (issue #251). Two things used to take it away:

- The drag handle needs `@tiptap/extension-node-range`, whose keymap bound
  `Shift+ArrowUp/Down` unconditionally and turned any text selection into a
  selection of whole blocks, anchored at the start of the paragraph. The page
  editor uses `BlockNodeRange` (`apps/web/src/components/editor/node-range.ts`)
  instead, which only grows a block range that already exists and leaves every
  text selection to the browser. Do not add the bare `NodeRange` back.
- At an opaque block (image, file, formula, embed, divider) Chromium stops a
  growing selection for good or drops its anchor, Firefox cannot go down past an
  image, and a table entered from outside catches the head in a cell and loses
  the anchor in both. `ShiftArrowSelection` (`shift-arrow-selection.ts`, registry
  entry `shift-arrow-selection`, ahead of the table keymap by priority) takes
  over exactly those presses: at the edge of a paragraph (left/right) or on its
  first or last line (up/down, measured by `view.endOfTextblock`), when the way
  to the next text crosses an opaque block or a table that does not hold the
  anchor, the head jumps to that text and the block or the whole table becomes
  part of the selection. Every other press is untouched. Selecting between
  table cells stays the table's own cell selection.

Covered by `shift-arrow-selection.test.ts`, `node-range.test.ts` in the web app
and the browser test in `e2e/tests/editor.spec.ts`.

## Moving blocks: the drop line and the keyboard

A block dragged by its handle lands where a line says it will (issue #243).
`BlockDrop` (`block-drop.ts`, registry entry `block-move`, behaviour only)
takes every drop of whole blocks away from ProseMirror's `dropPoint`; dragging
selected text keeps the old behaviour.

- The pointer's height picks the gap between two _drop leaves_ (text blocks,
  opaque blocks, a whole table). Every position in that gap where the dragged
  content fits is a candidate level (`blockDropCandidates`): the end of a
  sub-list, the end of the item holding it, the end of the list, the page.
  Places inside the dragged blocks and in front of a list item's own text are
  never offered.
- A list item where only a block fits gets a list of its source's kind around
  it (`dropWrapType`): that is how an item becomes a sub-item, and why a
  numbered item stays numbered and a task stays a task.
- Between two items of a list, a block that is no item of it (a paragraph, a
  heading, a picture, an item of another kind of list) is offered the place at
  the list's own level as well (`split` on the candidate): the drop splits the
  list there with `splitListAt` (`list-split.ts`) and puts the block between
  the halves. Both halves keep the list's kind, every item keeps its
  sub-items, the first half keeps the list's block id, and a numbered second
  half starts again at one. Its line starts where the list starts. Between two
  sub-items the same happens one level in: the sub-list is split and the block
  stands inside the item that held it.
- The pointer's horizontal position picks the level: the block is carried
  sideways with the pointer, so the candidate whose text start is nearest to
  where the carried block's text would be wins, and a place that needs no new
  list beats one that does at the same indentation.
- The line (`.exocortex-drop-line`, the page tree's amber line) starts where
  the dropped block's text will start and runs to its container's right edge.
  Before that start it runs on faintly from the shallowest level the same gap
  offers, and the row the block will follow or sit under is tinted
  (`.exocortex-drop-anchor`), the way Notion shows the level.
  The carried blocks get `.exocortex-drag-source`. No candidate under the
  pointer means no line and no drop.
- The drop is one transaction: `deleteRange` on the source (so an emptied
  sub-list goes with its last item), then the insertion mapped through it.
  Block ids travel with the blocks, and `Strg+Z` takes it back in one step.

`MoveBlock` (`move-block.ts`, same registry entry) is the keyboard half:
`Mod-Shift-ArrowUp/Down` swaps the block the cursor is in with its neighbour.
`movableBlockAt` names the block a person would grab: the list item rather than
its paragraph, the table rather than a cell, a selected image itself. The
handle's menu offers the same two steps.

At the first or last place of a list, a quote or a callout the next press
takes the block out of it, to stand right before or after it (`edgeMove`):

- a sub-item becomes an item of the list one level out, before or after the
  item that held it, and a sub-list it empties goes with it;
- an item of an outermost list becomes ordinary blocks (`liftListItemOut` in
  `list-split.ts`): its text a paragraph, its sub-items a list right under it,
  and a task's tick is not kept;
- a block in a quote or callout leaves it, and the container stays;
- a block that is the only thing in its list, quote or callout takes the
  container along, so a lone bullet stays a bullet and a one-line quote stays
  a quote.

The other way round nothing enters: a neighbour that holds blocks (a list, a
quote, a callout, an item with sub-items) is passed as a whole, so a block is
only ever put inside a container on purpose, by dragging it there. Notion
passes its bullets one at a time because a Notion bullet is a block of its own;
here a list is one block, and stepping between its items would split it at
every press. Columns, table cells, toggles and the page stop the key at their
edge, and inside a list item nothing moves above the item's own text.

`liftListItemOut` turns an item anywhere in its list into blocks, splitting
the list around it; "Umwandeln in" in the handle's menu uses it for a list
item too (issue #284, next section).

In the web app the handle belongs to the block under the pointer, a nested
one included (`NESTED_TARGETS` in `handle-hover.ts`, docs/deviations.md 17,
issue #286): over a block's text it is that block, left of a block inside a
quote, callout, column or table cell it is the container, and a list item
never gives way to the item around it. Once the handle stands beside a block,
the strip from that block's line to the handle is the block's, so the pointer
can travel to the handle of a sub-item without the item above taking it. The
handle's
menu opens on release without movement, never on the press that may start a
drag (issue #268), and a drag closes it. Covered by `block-drop.test.ts`,
`move-block.test.ts`, `list-split.test.ts` and `e2e/tests/block-drag.spec.ts`.

## The handle's menu acts on its block

"Umwandeln in" and "Farbe" in the handle's menu change the block the handle
stands beside, wherever the caret is (issue #229). Both are written for the
selection (the catalog's `run` and the `textColor` mark), and opening the menu
moves no selection, so before #229 a conversion changed the block holding the
caret and a colour on a collapsed caret only set a stored mark nobody saw.

`runOnBlock` (`block-target.ts`) selects the block first and runs the ordinary
command on that; `blockContentSelection` says what "the block" is:

- a text block: all of its text;
- a block holding others (a list item with its sub-items, a quote, a callout,
  a toggle): from its first text block to its last, so a list toggle acts on
  the list the item stands in, the quote toggle lifts the whole quote, and a
  colour covers everything that moves with the block when it is dragged;
- a block without text (a picture, a divider): the block as a node selection.

Afterwards the caret stands collapsed at the end of what the block's text
became, so writing continues there and no selection raises the formatting
toolbar. Selecting changes no content, so `Strg+Z` takes the action back in
one step. In the web app `runOnTarget` finds the block again by its id first,
because the document may have moved since the handle picked it; the selection
toolbar passes no target and keeps working on the selection the person made.
Covered by `block-target.test.ts` and `e2e/tests/block-menu.spec.ts`.

A list item is the exception for "Umwandeln in" (issue #284). Selected as a
whole it spans its sub-items, so "Absatz" changed nothing (the text already
is a paragraph), a quote or a callout could not wrap the paragraph that has to
stay the item's first child, and a heading or a code block landed on the last
sub-item. `turnBlockInto` (`block-target.ts`, in the web app `turnTargetInto`)
takes the item out of its list first with `liftListItemOut`: its text becomes
a paragraph where it stood, its sub-items stay a list directly underneath, and
the items before and after stay lists of their own (a numbered second half
starts again at one, a task's tick is not kept). Then the entry runs on that
paragraph alone, so a heading, a quote or a callout holds the item's text and
the sub-items stay below it. A list entry of the item's own kind just takes it
out; one whose items are of another type (a task list from a bullet list, or
back) makes it an item of a list of that kind, sub-items still nested; bullet
and numbered keep changing the whole list the item stands in. The caret ends
after the item's text, and the lift and the conversion go back with one
`Strg+Z`. Which list an entry makes is its `makesList` in the catalog.

"Löschen" in the same menu leaves the caret where the block stood (issue #285).
It used to run `chain().focus().deleteRange()`: the focus is in the menu, so
`focus()` put back the selection from before the menu opened (where the caret
had last been, or the start of the page if it never was placed) and scrolled
that into view on the next frame. Deleting a heading halfway down a long page
sent the reader to the top, or a screen further down. `deleteBlockRange` in
`apps/web/src/components/editor/block-target.ts` deletes and puts the caret at
the start of the block that followed, which is on screen, so focusing scrolls
nothing. Covered by `apps/web/src/components/editor/block-target.test.ts` and
`e2e/tests/scroll-position.spec.ts`.

## The hint in the empty line

„Schreibe etwas oder tippe „/“ für Befehle …“ is `LinePlaceholder`
(`line-placeholder.ts`, issue #227), added by the page editor with the hint in
the reader's language; it is not in the registry because a read-only editor
never shows it. It is a node decoration (`is-empty`, `data-placeholder`), drawn
by `globals.css` as `::before`, so it never reaches the Yjs state, the text,
the Markdown or the clipboard.

Where it stands, all of it in `linePlaceholderPosition`: in the paragraph the
caret is in, only while the caret is collapsed and the paragraph has no
content at all (a hard break, a formula or a mention count), and only while
the editor has the focus, except on a page that is nothing but one empty line.
Tiptap's `Placeholder` is deliberately not used: it keeps its decorations in a
state field and recomputes only the top-level blocks a transaction touched,
with a range one position short, so a top-level line the caret left kept its
hint. The decoration here is derived from the state on every update and keeps
nothing between transactions, so typing, `Enter`, a paste, an undo or a change
from another tab cannot leave one behind. Tiptap dispatches a transaction on
focus and blur, which is what redraws it when the focus moves. The look (muted
and italic) is DESIGN.md's Hint-Is-Not-Ink Rule. The list continuation below
swaps the text through the same class. Covered by `line-placeholder.test.ts`
and `e2e/tests/editor.spec.ts`.

## Continuing a list across a block

An empty line below a list, with a picture, a quote or a table in between,
offers to continue the list (issue #240). `ListContinuation`
(`list-continuation.ts`, registry entry `list-continuation`, behaviour only)
answers two things from one function, `findListContinuation`:

- **The preview.** While the caret stands in such a line, a node decoration
  (`.exocortex-list-ghost`) indents it to where the new point's text will be,
  draws the point's marker pale in front of it (bullet, next number, empty task
  box) and replaces the placeholder with the `Tab` hint from
  `EditorWords.listContinuation`. It is a decoration only: nothing reaches the
  Yjs state, and the first character typed removes it, so the line stays a
  paragraph. The look lives in `globals.css` and uses the placeholder's token.
- **`Tab`.** Turns the line into the next point in one transaction (one undo
  step); the line keeps its block id and the caret stays in it. Everywhere the
  function says no, `Tab` returns false and keeps its old meaning: nesting a
  point, the next table cell, the code block.

The rules: the last list before the line counts, across at most
`LIST_CONTINUATION_MAX_GAP` (2) blocks, and a heading ends the connection.
Directly after the list the point goes to the level of the last point, into a
sub-list if the list ends in one; across a block it goes to the level of the
list beside that block, because a sub-point there would need an empty point
above it. A numbered list continues with its next number (`start`), a task list
with an unchecked task. An empty line inside a point below a picture (what
`Strg+Enter` and an inserted image leave) becomes the next point of the same
list, taking whatever follows it in the point along. Table cells are excluded.
`- ` and `1. ` still start a list of their own. Covered by
`list-continuation.test.ts` and `e2e/tests/editor.spec.ts`.

**`Backspace` in the empty line right below a list** (issue #302) removes the
line and puts the caret at the end of the list's last point, at whatever depth
it stands, in one transaction (`backspaceBelowListTransaction`). ProseMirror's
`joinBackward` instead wrapped the line into a new empty point, and the next
press joined that point into the one above as a second paragraph; both times
the line stood where the preview had already drawn its pale marker, so two
presses (three below a sub-list) changed nothing on screen. The rule holds below
every list, also in a table cell, and only for a line without content: text
below a list, an empty point of its own and a line below a picture keep the
keymap they had.

## A line after the last block

A page that does not end in an empty paragraph (a picture, a table, a code
block, a database, a PDF, a list, a heading, or a paragraph with text in it,
such as a link or a bare address) keeps a line below it to write in (issues
#257 and #303; before #303 a page ending in a paragraph with text only got a
caret behind its last character). `TrailingParagraph` (`trailing-paragraph.ts`, registry entry
`trailing-paragraph`, behaviour only) makes the paragraph there **on use and
never in advance**:

- **The line is drawn, not stored.** While `needsTrailingParagraph` holds, the
  editor carries `data-trailing-line`, and `globals.css` reserves one
  paragraph's worth of space below the last block (only while the page is
  being written). Tiptap's `TrailingNode` is deliberately not used: it would
  write an empty paragraph into the Yjs state whenever a page is opened, which
  is the write nobody made that once left a blank line behind on every visit
  (see `collaboration-connection.ts`). A gap cursor is not used either: it
  cannot stand after a code block or a callout, and the empty line below a list
  and a picture has to be a real paragraph for the list continuation above to
  be offered in it.
- **A click** on the editor's own surface below the last block appends one
  paragraph and puts the caret into it. A click on a block, its controls or a
  node view stays that block's, and a modifier key leaves the press to the
  browser.
- **Arrow down** does the same from the bottom of the page
  (`arrowDownLeavesPage`): from a selected picture or embed, from any cell of a
  table's last row, or from the last line of the text the page ends in, as long
  as nothing selectable follows. In a paragraph the page ends in, only from its
  end: on its last line arrow down first moves the caret to the end of that
  line, as it always did. It runs after the suggestion menus' keys and
  before the table's own arrow handling.

One transaction, one undo step. Once the page ends in an empty paragraph there
is nothing left to do, so a second click never makes a second empty line; a line
made and left empty stays, as one made with `Enter` would. Covered by
`trailing-paragraph.test.ts` (including that opening a page writes nothing to
the Yjs state) and `e2e/tests/editor.spec.ts`.

## Room past the end of the page

While the page's own editor is being written in, the last line can be
scrolled up to about the middle of the screen, and typing on it keeps it off
the bottom edge (issue #281, "scroll past end"). Nothing of it is stored, so
the Yjs state, the search projection and the export never see it:

- **The space is padding.** `globals.css` gives
  `.ProseMirror.exocortex-editor-canvas[contenteditable='true']` a
  `padding-block-end` of half the viewport less what already lies below the
  scroller's middle, and never less than the trailing line above. Because it
  is the editor's own surface, a click into it is a click below the last
  block: it opens the line `TrailingParagraph` draws, or, on a page already
  ending in an empty paragraph, puts the caret there. Screen only (`@media
screen`), so a printed page ends with its text; a page that is only read
  (no write access, archived, `/geteilt/<id>`) is not `contenteditable` and
  keeps its length, as with the trailing line; a transclusion's editor is not
  the canvas.
- **Following the caret is ProseMirror's.** `WritingRoom`
  (`apps/web/src/components/editor/writing-room.ts`, page editor only) sets
  `scrollThreshold` and `scrollMargin` at the bottom to `bottomRoom`: a quarter
  of the visible page (48 to 200 pixels), plus whatever part of the scroll
  container the visual viewport does not show. That second part is the
  on-screen keyboard: it shrinks only the visual viewport, so without it a
  line made with `Enter` was scrolled into view behind the keyboard. The value
  is a getter on the prop object, read each time ProseMirror scrolls, so no
  listener and no scroll code of our own is involved.

Covered by `writing-room.test.ts` and `e2e/tests/writing-room.spec.ts`
(desktop, print, an archived page, and a phone with a simulated keyboard).

## Where a new code block goes

The catalog's "Codeblock" (slash menu, selection toolbar), `Mod-Alt-c` and a
fence typed at the start of a line (` ``` `, ` ```ts `, `~~~`) all
go through `placeCodeBlock` (`code-block-placement.ts`, issue #318), wired in
by overriding `setCodeBlock`, `toggleCodeBlock` and the input rule in
`code-block.ts`. Upstream ended every one of them in `setBlockType` on the
text block holding the caret. A list item's first paragraph cannot change
type, so Tiptap's `setNode` lifted it out of every list first (`clearNodes`):
the item's text went into the code, the list was split around it, a nested
sibling lost its indentation, and an item with sub-items changed nothing.
`Umschalt+Enter` for a fresh line under an item's text is still the same
paragraph, which is how "the text above came along". The fence never fired
in a list item or after a line break at all. The rule now, as Notion keeps it:

- **An empty line becomes the block.** An empty paragraph turns into it where
  it stands. An empty list item is replaced by it (`liftListItemOut`): the
  list splits around it, a numbered second half starts again at one, and
  sub-items the empty item held stay a list directly underneath. A sub-item
  is replaced inside its parent item, so the block keeps the indentation. An
  empty line after `Umschalt+Enter` leaves its paragraph together with its
  line break, and the block stands where the line stood: under the text, or
  between the two halves when the line was in the middle.
- **Text stays where it is.** With the caret on a list item's text, a new,
  empty block goes directly under that text, inside the same item and before
  its sub-items. A free text block (a paragraph, a heading, a second
  paragraph in an item) still turns into the block, text and all: nothing has
  to move for that.
- **A selection becomes code, and only the selection.** Inside one text block
  the selected text is cut out into the block; the text before stays, the
  text after follows the block as a block of its own. A selection of a list
  item's whole text replaces the item, which is also what "Umwandeln in" in
  the handle's menu does (issue #284). A selection over several blocks, and
  the command inside a code block (back to a paragraph), are upstream's.
- **Backspace in an empty code block inside a list item** makes it an empty
  line of that item again; upstream's `clearNodes` lifted it out of the list.

The change is planned on a transaction of its own and copied over only when
it worked, so it is one dispatch and `Strg+Z` takes it back in one step.
Covered by `code-block-placement.test.ts` and `e2e/tests/editor.spec.ts`.

## Backspace and Delete next to a code block

ProseMirror's `joinBackward` and `joinForward` treat a code block like any
text block and join it with its neighbour (issue #319). A code block keeps its
lines as `\n` inside one text node, so the join turned them into line breaks
of the paragraph above (the schema's `linebreakReplacement`) and the block was
gone; after a list the code landed in the last point as raw newlines, after a
callout it moved into the callout, after a picture the picture was deleted,
and as the first block of the page Tiptap's `clearNodes` turned it into a
paragraph full of newlines. The other way round, the text below a code block
was pulled into the code. Removing the empty lines above a code block from its
first character broke the block the moment the last empty line was gone.

`code-block-edges.ts` answers both keys first, from the code block's own
keymap in `code-block.ts`. The rule: **a code block is never joined with a
neighbour by Backspace or Delete.** One key removes at most one empty line
between the block and its neighbour; otherwise the caret moves and nothing
changes type.

- Backspace in an empty line above a code block removes the line (also at the
  top of the page, where it used to do nothing).
- Backspace at the start of a code block with code in it: an empty line
  directly above goes and the block moves up; otherwise the caret goes to the
  end of the block above (the last point of a list, the text of a callout),
  or a block without text (a picture) is selected. As the first block of the
  page, or of a column or table cell, nothing happens.
- Backspace at the start of an empty code block makes it an empty paragraph
  where it stands, inside a list item too (#318), keeping its block id.
- Backspace at the start of the line below a code block: an empty line goes,
  text stays where it is; the caret goes to the end of the code.
- Delete at the end of the line above a code block (also the last point of a
  list above it): an empty line goes, text stays, the code is never pulled in.
- Delete at the end of a code block: an empty line below goes, a picture
  below is selected, anything else stays.

Every outcome is one transaction, so `Strg+Z` takes it back in one step. A
selection across the block's edge is still ProseMirror's ordinary deletion.
Covered by `code-block-edges.test.ts` and `e2e/tests/editor.spec.ts`.

## Code highlighting

A code block stores only its language's name (`language` attribute, the word
after a Markdown fence); the colours are decorations derived at render time,
so nothing about highlighting is ever written to the Yjs state (issue #317).

- **The plugin** (`code-highlight.ts`) replaces the one in
  `@tiptap/extension-code-block-lowlight`, which is no longer a dependency. It
  recomputes from node identity rather than from the shape of a transaction:
  an unchanged block is the same immutable node object, so a block whose text
  or language changed is a new object and is highlighted again, whatever the
  change was (typing, the bar's language picker with the caret elsewhere, an
  undo, a write from the collaboration server). Spans of unchanged blocks come
  from a `WeakMap` keyed by the node.
- **No guessing.** An empty language, `text`, or a name no grammar knows
  draws no colour at all. The upstream plugin called `highlightAuto` there,
  which coloured terminal output as Python. Automatic detection is not offered
  as an option either: on short snippets and on output it is wrong more often
  than right, and it would run every grammar on every keystroke.
- **Grammars** are registered one by one in `code-block.ts`. `bash` and
  `console` are our wrappers in `code-grammars.ts`: `bash` adds commands,
  options and paths to upstream's grammar (alias `shell`), `console` is a
  terminal session where a line starting with a prompt (`user@host:~$`,
  `host:~/scripts #`, `[me@box dir]$`, `$`, `#`) is a bash command and every
  other line is output, left plain. A block stored as `bash` (or `sh`,
  `shell`) that holds one unmistakable prompt (`looksLikeSession`: a host or
  path before the `$`/`#`, or a bare `$ `) is highlighted as `console`; its
  stored language is not touched. Most "Shell" blocks are pasted terminals,
  and read as a script their prompt's `#` opened a comment. `dotenv` and `env`
  are aliases of `ini`. Code renders with `translate="no"`, so a browser's page
  translation leaves it alone.
- **Colours** are the `--syntax-*` tokens (`tokens.css`, DESIGN.md §2 "Syntax"),
  mapped from highlight.js classes in `apps/web/src/app/globals.css`. The AI
  chat renders fenced code with the same registry through `highlightCode`.

A new language is an import and a line in `lowlight.register`, plus an entry in
`CODE_BLOCK_LANGUAGES` if the picker should offer it. Covered by
`code-block.test.ts` and `e2e/tests/editor.spec.ts`.

## Markdown

- import: `parseMarkdown(markdown)` → ProseMirror JSON (markdown-it token walker)
- export: `serializeMarkdown(document, options)` → deterministic Markdown
- Yjs bridge: `markdownToYjsState`, `yjsStateToMarkdown`, `materializeYjsState`

Supported: YAML frontmatter (unknown keys preserved), headings, emphasis, inline
code, fenced code with language, blockquotes, bullet/ordered lists, task lists,
tables, images, links, wiki links (`[[Seite]]` and `[[Seite|Label]]`), horizontal
rules, hard breaks, callouts, optional block ids, the inline styling marks
(`==hervorgehoben==`, `++unterstrichen++`, `^hoch^`, `~tief~`), mentions
(`@[[Seite]]`, `@[Person]`, `@(2026-08-04)`), mathematics (`$inline$` and `$$block$$`)
and the container blocks below.

### Container syntax

Blocks CommonMark has no notation for use a generic directive
(`packages/editor/src/markdown/container-rule.ts`):

```markdown
:::toggle Zusammenfassung
Inhalt
:::

::::columns
:::column
links
:::
:::column
rechts
:::
::::

:::toc
:::

:::page Andere Seite
:::

:::transclusion Projektseite^k3h9s0p2m1qa
:::

:::video /api/attachments/abc/download Aufzeichnung.mp4
:::

:::embed https://www.youtube-nocookie.com/embed/xyz
:::
```

Names in use: `toggle`, `columns`, `column`, `toc`, `breadcrumb`, `page`,
`database-embed`, `saved-query`, `transclusion`, `file`, `video`, `audio`,
`pdf`, `embed`, `bookmark`. A unit claims a name through the
`containers` field of its Markdown adapter and returns how many nodes it opened;
the importer closes exactly those at the matching `:::`. An unknown name is ignored
rather than dropped, so its content survives as plain blocks.

`:::transclusion` (issue #78, ADR-045) addresses its source by **title**, like
`:::page` and `[[Titel]]`, so an exported file carries no internal document
ids and an import binds the title back through `bindPageLinkIdentities`. What
follows the `^` is a block identifier and _is_ written, because it is the
address of the part and nothing else names it; a caret that is not followed by
a valid block identifier stays part of the title. An export may also be asked to
put the source's text in place of the reference
(`?transclusions=text`, `DocumentMarkdownService.applyTransclusions`), which is
what a file that leaves this deployment needs.

Callout syntax (Obsidian-compatible, issue #306):

```markdown
> [!warning] ⚠️ Optionale Überschrift
> Inhalt der Box
```

The keyword between `[!` and `]` is the frame colour, the emoji at the start of
the line the symbol, the rest the heading. Export writes the keyword other
tools colour the same way where there is one (`note` for the plain frame,
`info` blue, `success` green, `warning` yellow, `danger` red) and the colour's
own name otherwise (`gray`, `brown`, `orange`, `purple`, `pink`), and it always
writes the symbol. Import also reads a header without a symbol, which is how
every callout before #306 was written: the keyword then supplies the symbol too
(`warning` the warning sign, `note` the memo). GitHub's alerts (`[!NOTE]`,
`[!TIP]`, `[!IMPORTANT]`, `[!CAUTION]`), Obsidian's further types and aliases,
its fold marker (`[!note]-`) and its metadata (`[!note|wide]`) are read as well;
an unknown keyword is the plain frame with the light bulb. The table is
`CALLOUT_KEYWORDS` in `packages/editor/src/callout.ts`.

Block ids are written only with `{ includeBlockIds: true }`, as an Obsidian-style
`^id` suffix. Raw HTML is not accepted on import: HTML is never canonical and
accepting it would create an XSS surface.

Round-trip guarantees are covered by the fixtures in
`packages/editor/src/fixtures.ts`; the round-trip test iterates all of them
automatically. Exact whitespace is not preserved; semantic content is. The two
deliberate exceptions (text colour, non-default background) are in
`docs/deviations.md`.

## Adding a new block node

The `callout` node is the reference implementation. To add, for example, a
`toggle` node:

1. **Create the node** in `packages/editor/src/toggle.ts`:
   ```ts
   export const Toggle = Node.create({
     name: 'toggle',
     group: 'block',
     content: 'block+',
     addAttributes() {
       return { open: { default: false } };
     },
     parseHTML() {
       return [{ tag: 'details[data-toggle]' }];
     },
     renderHTML({ HTMLAttributes }) {
       return ['details', mergeAttributes(HTMLAttributes, { 'data-toggle': '' }), 0];
     },
   });
   ```
2. **Add a Markdown adapter** — a `blocks.toggle` serializer and, if the syntax is
   not already produced by markdown-it, a token handler.
3. **Register it** in `EXOCORTEX_EDITOR_EXTENSIONS` with the schema version it is
   introduced in.
4. **Make it addressable** by adding `'toggle'` to `ADDRESSABLE_BLOCK_TYPES`.
5. **Add a catalog entry** so it appears in the slash menu, the turn-into menu and
   the block menu (`block-catalog.ts`, or next to the node like `toggleBlocks`).
6. **Style it** in `apps/web/src/app/globals.css` under `.exocortex-editor`.
7. **Add a fixture** to `packages/editor/src/fixtures.ts` — the round-trip test
   iterates every fixture automatically.
8. Run `pnpm --filter @exocortex/editor test`.

The real `toggle` unit is `packages/editor/src/toggle.ts`; `columns.ts` is the
reference for a node with its own commands, `table-of-contents.ts` for one with a
plain-DOM node view. A plain-DOM node view never writes a sentence of its own:
it reads `this.options.words` (German by default), the node's name goes into
`WORDED_NODE_NAMES` in `extensions.ts`, and the text is a field of
`EditorWords` that `useEditorWords` in `apps/web` fills from `editor.nodeViews`
(docs/i18n.md).

## Page references and their identity

Three notations point at another page: the `pageLink` block, `mention` with
`kind: 'page'`, and the `link` **mark** carrying a `wiki:` address, which is
what `[[Titel]]` in running text becomes. All three store the **identity** of
the target (`documentId` / `id`) next to the **title** they display, and all
three write only the title to Markdown. `[[Titel]]` is therefore an interchange
format, not the storage format: an exported file still contains no internal
identifiers, and renaming a page no longer breaks the references to it
(issue #14 for the block, issue #24 for the mark).

The three pure operations that keep those two halves in step live in
`packages/editor/src/page-link-identity.ts`:

| Function                 | Used by                                        | Does                                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolvePageLinkTitles`  | Markdown export                                | rewrites every stored title from its identity, so a file says what the target is called _now_. For a mark it rewrites the address, and the visible text only when that text still _was_ the address — `[[Ziel\|siehe dort]]` is a wording the author chose |
| `bindPageLinkIdentities` | Markdown import, `POST /documents/:id/content` | maps a title back onto a page of the workspace                                                                                                                                                                                                             |
| `resolvePageLinkTarget`  | the `pageLink` node view                       | decides what a reference resolves to, identity first, title as the fallback, `unresolved` when neither answers                                                                                                                                             |

An unresolved reference is visible in both notations: the block says so on its
own card, a `[[Titel]]` in prose is marked by a ProseMirror decoration
(`apps/web/src/components/editor/wiki-link-markers.tsx`) rather than a stored
attribute — whether the other page exists is a fact about the workspace, not
about this document, and it has to change without this document being edited.

All three take the lookup as an argument, because only the application may talk
to the database; `apps/api/src/documents/page-link-identity.service.ts` supplies
it from one read of the workspace. A reference that resolves to nothing is
never dropped — it is shown as unresolved and offers to create the page.

## Document migrations

`EXOCORTEX_SCHEMA_VERSION` is stored on every `DocumentContent` and
`DocumentSnapshot` row. It is at **6**: version 2 added the full block set,
version 3 the database embed, version 4 the page link's identity, version 5 the
link mark's, version 6 the callout's symbol, heading and colour.

`SCHEMA_V2_MIGRATION` and `SCHEMA_V3_MIGRATION` are identity migrations — those
steps were purely additive. They exist because `migrateDocument` requires
exactly one migration per version step, which keeps the upgrade path explicit
instead of silently permissive. `SCHEMA_V4_MIGRATION`
(`packages/editor/src/schema-v4.ts`) is the first one that actually rewrites
nodes: it gives every `pageLink` an explicit `documentId: null`, so "no identity
recorded" is one case instead of two. `SCHEMA_V5_MIGRATION`
(`packages/editor/src/schema-v5.ts`) does the same for the `link` **mark**,
which is what `[[Titel]]` in running text is (issue #24) — the notation people
actually type, and the one #14 left behind. Neither can invent an identity —
that needs a workspace and a database — so old references keep resolving through
their title until someone edits them or the document passes the Markdown
boundary, where `bindPageLinkIdentities` binds them.

`SCHEMA_V6_MIGRATION` (`packages/editor/src/schema-v6.ts`, issue #306) is the
first that changes what a stored node _is_, and the first applied to the
canonical state rather than only to derived JSON. A callout's `variant`
becomes the `emoji` and `color` it stood for; a heading stays as it was and
none is invented. It runs in three places:

- `migrateCalloutsInYjsDoc` (`callout-yjs.ts`) sets and removes the attributes
  on the stored Yjs elements in one transaction, so the page keeps its history
  and nothing is rebuilt from Markdown. The collaboration server calls it in
  `afterLoadDocument` for every page it opens (an open page is its to write,
  ADR-016), and `pnpm --filter @exocortex/api documents:migrate-callouts`
  for every stored page at once, after a deploy; both are idempotent, so the
  two meeting on an open page store a migrated page whichever writes last.
- `currentContentOfState` (`migrations.ts`) derives a stored state and runs
  `migrateDocument` on it. Restoring a snapshot from an older schema goes
  through it and is applied as an edit like any other restore (before #306
  such a snapshot was put back byte for byte); the snapshot comparison derives
  both sides through it, so a migration does not show as a change.
- `resolveCallout` reads the old attribute wherever a callout is drawn or
  written out. `variant` stays in the schema, read only, for exactly that: a
  state a migration has not reached yet (a snapshot restored byte for byte, a
  browser that has not reloaded) still shows its symbol and colour.

To add one:

1. bump `EXOCORTEX_SCHEMA_VERSION` in `packages/editor/src/contract.ts`,
2. add a `DocumentMigration` (`fromVersion`, `toVersion`, `description`, `migrate`)
   to the `migrations` array of the extension that changed,
3. call `migrateDocument(json, storedVersion)` where stored content is read
   (`currentContentOfState` does both steps for a stored Yjs state),
4. if the change alters stored nodes rather than adding defaults, migrate the
   canonical state too, the way `callout-yjs.ts` does.

`migrateDocument` refuses to downgrade a document written by a newer build, and
requires exactly one migration per version step, so the path is deterministic.

## Server-side use

`getExocortexSchema()` builds the ProseMirror schema without a DOM, which is what
makes headless materialization and Markdown import possible in the worker and the
API. `validateProseMirrorDocument()` rejects invalid JSON before it can become
canonical Yjs state.
