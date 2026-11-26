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
| `turn-into-menu.tsx`            | convert the current block                                                                                                                                                                                                             |
| `color-menu.tsx`                | text and background colour                                                                                                                                                                                                            |
| `link-menu.tsx`                 | link editor: understands `[[Seite]]`, and searches the workspace's pages for anything that does not look like an address                                                                                                              |
| `link-bubble.tsx`               | bubble menu over the caret inside a link: open, edit, remove                                                                                                                                                                          |
| `follow-link-context.tsx`       | ref bridge that hands `EditorSurface`'s click handler and the `pageLink` node view a `follow` function without either holding it as state                                                                                             |
| `link-navigation.tsx`           | `useLinkNavigation`: what following a resolved link _does_ (new tab, router push, `wiki:` lookup plus its ambiguous/missing/error dialogs)                                                                                            |
| `emoji-menu.tsx`                | emoji picker (inserts characters)                                                                                                                                                                                                     |
| `slash-menu.tsx`                | `/` block menu, reads the catalog                                                                                                                                                                                                     |
| `mention-menu.tsx`              | `@` menu for pages, people and dates                                                                                                                                                                                                  |
| `block-handle.tsx`              | drag handle in the outer lane of the interaction gutter (docs/ui-system.md, and docs/deviations.md 17)                                                                                                                                |
| `block-actions.tsx`             | duplicate, copy link, delete — shared by handle and toolbar; a delete that loses a whole structure is confirmed first and re-finds its block by id afterwards                                                                         |
| `block-removal.ts`              | which blocks are worth a confirmation (compound ones, and anything above 280 characters) and what the dialog says about them (issue #91)                                                                                              |
| `destructive-confirm.tsx`       | the confirmation dialog itself. Rendered by `EditorChrome` and reached through a context, because every caller is a bubble menu or a drag handle that unmounts as soon as the text loses focus                                        |
| `suggestion-menu.tsx`           | shared state-driven machinery for `/` and `@`, including where the popup goes and how far its list may grow                                                                                                                           |
| `code-block-toolbar.tsx`        | language picker and copy                                                                                                                                                                                                              |
| `table-toolbar.tsx`             | rows, columns, header, merge, and the confirmed "Tabelle löschen"                                                                                                                                                                     |
| `block-prompt.tsx`              | value and file collection for catalog entries                                                                                                                                                                                         |
| `comment-markers.tsx`           | ProseMirror **decorations** on the blocks that carry an open comment thread, plus the two-way wiring to the Kommentare panel. Never a mark: a comment is not document content, so it must leave no trace in the Yjs state (issue #18) |
| `page-link-node-view.tsx`       | React node view for `pageLink`, see the exception below                                                                                                                                                                               |
| `page-link-context.tsx`         | ref bridge that lets the `pageLink` node view reopen the page picker, so a placed link can be re-targeted                                                                                                                             |
| `saved-query-embed-context.tsx` | the same ref bridge for the query block, so "Suche wechseln" reaches the picker (issue #74)                                                                                                                                           |
| `transclusion-node-view.tsx`    | React node view for `transclusion`: the header, the five states a reference can be in, and the read-only editor that renders the fragment (issue #78)                                                                                 |

Node views that render _inside_ the document (table of contents, breadcrumb, media)
live in `packages/editor` and are plain DOM, not React, so `getExocortexSchema()`
keeps working without a DOM on the server.

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

In the web app the handle targets nested blocks with the left edge only
(`NESTED_TARGETS` in `block-handle.tsx`, docs/deviations.md 17). The handle's
menu opens on release without movement, never on the press that may start a
drag (issue #268), and a drag closes it. Covered by `block-drop.test.ts`,
`move-block.test.ts` and `e2e/tests/block-drag.spec.ts`.

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

Callout syntax (Obsidian-compatible):

```markdown
> [!warning] Optionaler Titel
> Inhalt der Box
```

Variants: `info`, `note`, `success`, `warning`, `danger`.

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
`DocumentSnapshot` row. It is at **5**: version 2 added the full block set,
version 3 the database embed, version 4 the page link's identity, version 5 the
link mark's.

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

To add one:

1. bump `EXOCORTEX_SCHEMA_VERSION` in `packages/editor/src/contract.ts`,
2. add a `DocumentMigration` (`fromVersion`, `toVersion`, `description`, `migrate`)
   to the `migrations` array of the extension that changed,
3. call `migrateDocument(json, storedVersion)` where stored content is read.

`migrateDocument` refuses to downgrade a document written by a newer build, and
requires exactly one migration per version step, so the path is deterministic.

## Server-side use

`getExocortexSchema()` builds the ProseMirror schema without a DOM, which is what
makes headless materialization and Markdown import possible in the worker and the
API. `validateProseMirrorDocument()` rejects invalid JSON before it can become
canonical Yjs state.
