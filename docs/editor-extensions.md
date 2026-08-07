# Editor extensions

`packages/editor` owns the canonical document schema. React components must never
define schema-relevant Tiptap extensions.

## The contract

```ts
export interface ExocortexEditorExtension {
  name: string;
  schemaVersion: number;
  extensions: Extensions;              // Tiptap nodes/marks/plugins
  markdown?: MarkdownExtensionAdapter; // serializers, token and container handlers
  plainText?: PlainTextAdapter;        // search projection
  migrations?: DocumentMigration[];    // stored-document upgrades
  blocks?: BlockCatalogEntry[];        // slash menu, turn-into, block menu
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
`embed`, `callout`, `database-embed`, `block-id`.

## Supported nodes and marks

Nodes: `doc`, `paragraph`, `heading` (1–6), `text`, `codeBlock`, `blockquote`,
`bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `horizontalRule`,
`hardBreak`, `image`, `table`, `tableRow`, `tableHeader`, `tableCell`, `callout`,
`details` / `detailsSummary` / `detailsContent`, `columnList` / `column`,
`inlineMath` / `blockMath`, `tableOfContents`, `pageLink`, `breadcrumb`, `mention`,
`fileAttachment`, `video`, `audio`, `pdf`, `embed`, `bookmark`, `databaseEmbed`.

Marks: `bold`, `italic`, `strike`, `code`, `link` (including the internal `wiki:`
scheme), `underline`, `superscript`, `subscript`, `textColor`.

Asserted by `packages/editor/src/schema.test.ts`.

## The block catalog

`packages/editor/src/block-catalog.ts` describes every block a writer can insert or
convert into: a German label and description, search keywords, a group, an icon
*name* and a `run(editor, value?)`.

One list, three consumers — the slash menu, the "Umwandeln in" menu and the block
action menu. Adding a block means adding one catalog entry next to its extension;
it then appears in all three. The catalog names its icon instead of importing one,
because `packages/editor` has to stay renderer-free for headless use on the server;
`apps/web/src/components/editor/block-icon.tsx` resolves the names.

An entry that needs more than the editor declares it with `prompt`:
`'url'`, `'file'`, `'page'` or `'latex'`. The web layer collects the value
(`block-prompt.tsx`, including the attachment upload) and passes it into `run`.

## Editor UI

All of it lives in `apps/web/src/components/editor` and contributes **no** schema:

| File | Purpose |
| ---- | ------- |
| `selection-toolbar.tsx` | formatting bar over a selection |
| `turn-into-menu.tsx` | convert the current block |
| `color-menu.tsx` | text and background colour |
| `link-menu.tsx` | link editor, understands `[[Seite]]` |
| `link-bubble.tsx` | bubble menu over the caret inside a link: open, edit, remove |
| `follow-link-context.tsx` | ref bridge that hands `EditorSurface`'s click handler and the `pageLink` node view a `follow` function without either holding it as state |
| `link-navigation.tsx` | `useLinkNavigation`: what following a resolved link *does* (new tab, router push, `wiki:` lookup plus its ambiguous/missing/error dialogs) |
| `emoji-menu.tsx` | emoji picker (inserts characters) |
| `slash-menu.tsx` | `/` block menu, reads the catalog |
| `mention-menu.tsx` | `@` menu for pages, people and dates |
| `block-handle.tsx` | drag handle in the gutter (see docs/deviations.md) |
| `block-actions.tsx` | duplicate, copy link, delete — shared by handle and toolbar |
| `suggestion-menu.tsx` | shared state-driven machinery for `/` and `@` |
| `code-block-toolbar.tsx` | language picker and copy |
| `table-toolbar.tsx` | rows, columns, header, merge |
| `block-prompt.tsx` | value and file collection for catalog entries |
| `page-link-node-view.tsx` | React node view for `pageLink`, see the exception below |

Node views that render *inside* the document (table of contents, breadcrumb, media)
live in `packages/editor` and are plain DOM, not React, so `getExocortexSchema()`
keeps working without a DOM on the server.

**Two exceptions:** `databaseEmbed` (`database-embed.ts`) and `pageLink`
(`page-link.ts`). Their schema (attributes, `parseHTML`/`renderHTML`, Markdown
adapter) lives in `packages/editor` like every other node, but each declares
no `addNodeView()` — the interactive rendering is a real React node view
supplied entirely by `apps/web`, wired in via `.extend({ addNodeView: () =>
ReactNodeViewRenderer(...) })` on the extension instance in
`collaborative-editor.tsx`.

For `databaseEmbed` that is a live `DatabaseShell`, the same component the
full-page database view uses: reusing it outweighs hand-building filters,
inline cell editing and four view layouts again in plain DOM.

For `pageLink` (`page-link-node-view.tsx`) it is the block's *resolution
state*: whether the title matches one page, several, or none, and that page's
icon and archived status. A plain anchor cannot say any of that without a
network request, and knowing which page a title resolves to is application
knowledge, not schema knowledge — `packages/editor` still only ever stores the
title. The click itself is handled the same way for both: neither node view
calls `stopPropagation` as a guard against the editor-wide click handler
(`followFromEvent` in `collaborative-editor.tsx`, described below), because
React's event system sits above ProseMirror's `view.dom` listener and would
run too late. The guard is the `[data-page-link]` attribute the click handler
checks for instead.

New interactive embeds should follow this pair (schema-only node in
`packages/editor`, `ReactNodeViewRenderer` override in `apps/web`) rather than
inventing another mechanism.

Two rules hold for this layer, both learned the hard way (docs/deviations.md 17–18):

* **the component that owns `useEditor` must hold no state.** Tiptap re-applies its
  options after every render of that component, which makes ProseMirror rebuild
  every plugin view; anything stateful belongs in `EditorChrome`.
* **suggestion menus render from the plugin state**, never from the suggestion
  renderer's `onStart`/`onExit`, because those do not survive a plugin-view rebuild.

## Stable block identifiers

Every addressable block carries a `blockId` attribute (rendered as
`data-block-id`). `ADDRESSABLE_BLOCK_TYPES` lists them.

The `BlockId` extension:

* assigns an id to every newly created block,
* preserves ids while editing, during collaboration and during Markdown import,
* detects duplicates (copy/paste, concurrent edits, malformed import) and
  re-assigns the later occurrence,
* uses `keepOnSplit: false`, so splitting a paragraph produces a *new* id instead of
  a duplicate,
* marks its transactions `addToHistory: false`, so bookkeeping never appears in the
  undo stack.

Identity is **never** derived from document offsets, Markdown line numbers or array
indexes.

Covered by `block-id.test.ts` (jsdom, 8 tests) including split, duplicate repair and
an HTML round trip.

## Markdown

* import: `parseMarkdown(markdown)` → ProseMirror JSON (markdown-it token walker)
* export: `serializeMarkdown(document, options)` → deterministic Markdown
* Yjs bridge: `markdownToYjsState`, `yjsStateToMarkdown`, `materializeYjsState`

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

:::video /api/attachments/abc/download Aufzeichnung.mp4
:::

:::embed https://www.youtube-nocookie.com/embed/xyz
:::
```

Names in use: `toggle`, `columns`, `column`, `toc`, `breadcrumb`, `page`,
`database-embed`, `file`, `video`, `audio`, `pdf`, `embed`, `bookmark`. A unit claims a name through the
`containers` field of its Markdown adapter and returns how many nodes it opened;
the importer closes exactly those at the matching `:::`. An unknown name is ignored
rather than dropped, so its content survives as plain blocks.

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
     addAttributes() { return { open: { default: false } }; },
     parseHTML() { return [{ tag: 'details[data-toggle]' }]; },
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
plain-DOM node view.

## Document migrations

`EXOCORTEX_SCHEMA_VERSION` is stored on every `DocumentContent` and
`DocumentSnapshot` row. It is at **2**: version 2 added the full block set. Every
addition was purely additive, so `SCHEMA_V2_MIGRATION`
(`packages/editor/src/schema-v2.ts`) is an identity migration. It exists because
`migrateDocument` requires exactly one migration per version step, which keeps the
upgrade path explicit instead of silently permissive.

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
