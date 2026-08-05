# Editor extensions

`packages/editor` owns the canonical document schema. React components must never
define schema-relevant Tiptap extensions.

## The contract

```ts
export interface ExocortexEditorExtension {
  name: string;
  schemaVersion: number;
  extensions: Extensions;              // Tiptap nodes/marks/plugins
  markdown?: MarkdownExtensionAdapter; // block/mark serializers + token handlers
  plainText?: PlainTextAdapter;        // search projection
  migrations?: DocumentMigration[];    // stored-document upgrades
}
```

The registry is `EXOCORTEX_EDITOR_EXTENSIONS` in
`packages/editor/src/extensions.ts`. `buildEditorExtensions()` flattens it for
Tiptap, `buildMarkdownRegistry()` and `buildPlainTextRegistry()` merge the adapters,
`collectMigrations()` collects migrations.

Current units: `core-structure`, `core-marks`, `lists`, `tables`, `media`,
`callout`, `block-id`.

## Supported nodes and marks

Nodes: `doc`, `paragraph`, `heading` (1–6), `text`, `codeBlock`, `blockquote`,
`bulletList`, `orderedList`, `listItem`, `taskList`, `taskItem`, `horizontalRule`,
`hardBreak`, `image`, `table`, `tableRow`, `tableHeader`, `tableCell`, `callout`.

Marks: `bold`, `italic`, `strike`, `code`, `link` (including the internal `wiki:`
scheme).

Asserted by `packages/editor/src/schema.test.ts`.

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
rules, hard breaks, callouts and optional block ids.

Callout syntax (Obsidian-compatible):

```markdown
> [!warning] Optionaler Titel
> Inhalt der Box
```

Variants: `info`, `note`, `success`, `warning`, `danger`.

Block ids are written only with `{ includeBlockIds: true }`, as an Obsidian-style
`^id` suffix. Raw HTML is not accepted on import: HTML is never canonical and
accepting it would create an XSS surface.

Round-trip guarantees are covered by 26 tests over seven fixtures
(`packages/editor/src/fixtures.ts`). Exact whitespace is not preserved; semantic
content is.

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
5. **Style it** in `apps/web/src/app/globals.css` under `.exocortex-editor`.
6. **Add a fixture** to `packages/editor/src/fixtures.ts` — the round-trip test
   iterates every fixture automatically.
7. Run `pnpm --filter @exocortex/editor test`.

## Document migrations

`EXOCORTEX_SCHEMA_VERSION` is stored on every `DocumentContent` and
`DocumentSnapshot` row. There are no migrations yet (the schema is at version 1);
the machinery exists so the first schema change is a data change, not an
architecture change.

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
