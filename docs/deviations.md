# Deviations from the original brief

Every deviation below is deliberate. Where a requirement could not be met exactly,
the reason and the replacement are documented.

## 1. shadcn components are Radix-based in the public registry

**Brief:** "Use Base UI primitives for new shadcn components."

**Reality:** the public shadcn registry (`https://ui.shadcn.com/r/...`) only ships
Radix-based sources today; no Base UI registry was reachable
(`base-ui.shadcn.com`, `/r/base-ui/...` and `/r/styles/base-ui-v4/...` all fail).

**What was done:** components were installed with the official CLI
(`pnpm dlx shadcn@4.16.1 add …`), then adapted to Base UI:

- `button.tsx` and `badge.tsx`: Radix `Slot` replaced with Base UI `useRender`
  (`render` prop instead of `asChild`)
- `label.tsx`: the Radix primitive only rendered a `<label>`, so the native
  element is used
- every interactive component (`dialog`, `dropdown-menu`, `tooltip`, `tabs`,
  `scroll-area`, `separator`, `context-menu`, `avatar`) is written directly against
  `@base-ui-components/react`
- the `radix-ui` dependency the CLI added was removed again

The result contains no Radix code. See `docs/ui-system.md`.

## 2. Prisma 6 instead of Prisma 7

Prisma 7 is the newest release. Prisma 6.19.3 was chosen because it is the version
Better Auth's Prisma adapter is tested against and because its `prisma-client-js`
generator works unchanged in both the CJS server builds and the ESM browser build.
Upgrading is a contained change: regenerate the client and adjust
`packages/database/prisma/schema.prisma`.

## 3. TypeScript 5.9 instead of TypeScript 7

TypeScript 7.0 (the native port) is available but `typescript-eslint`, NestJS
decorator metadata and `next`'s type plugin are not yet validated against it.
5.9.3 is the newest release the whole toolchain supports.

## 4. ESLint 9 instead of ESLint 10

`typescript-eslint@8` supports ESLint 9; the ESLint 10 peer range is not yet
covered by all plugins used here.

## 5. Redis event bus instead of the Socket.IO Redis adapter

**Brief:** "Create a Redis adapter boundary for future horizontal scaling."

**What was done:** `packages/queue/src/event-bus.ts` implements a validated Redis
pub/sub bus. Every process publishes application events to one channel and every
API instance re-emits them into its local Socket.IO rooms. This covers the same
scaling boundary, additionally lets the _worker_ publish events (which the
Socket.IO adapter cannot), and validates payloads on both ends. Using both
mechanisms at once would double-deliver events.

## 6. Block identifiers in Markdown are opt-in

**Brief:** "preserves IDs during export where the format allows it."

Markdown has no attribute syntax. `serializeMarkdown(doc, { includeBlockIds: true })`
writes an Obsidian-compatible `^id` suffix, and the parser reads it back.
The default export omits identifiers so exported files stay clean. Round-tripping
with identifiers is covered by
`packages/editor/src/markdown/markdown.test.ts` → "preserves block ids when they
are included in the export".

Container nodes (lists, tables) do not carry an id in Markdown; paragraphs,
headings, code blocks, list items, task items and callouts do.

## 7. MIME detection is implemented locally

`file-type` is ESM-only, which does not combine with the CommonJS builds of the
API and worker. `packages/storage/src/mime.ts` implements a short, auditable
signature table for exactly the formats Exocortex allows, plus a UTF-8 text check.
It is covered by 11 unit tests, including "rejects an executable disguised as an
image".

## 8. `packages/ui` and `packages/editor` are consumed as source by the browser

Both are listed in `transpilePackages`. For `packages/ui` this lets Tailwind see
the class names. For `packages/editor` it is a correctness requirement: mixing its
CommonJS build into the ESM browser bundle produces two ProseMirror module
instances, which makes ProseMirror reject plugins with
"Adding different instances of a keyed plugin". Server processes keep using the
compiled CommonJS output through the `require` condition.

## 9. Explicit authentication rate limits

Better Auth's defaults were replaced with an explicit policy
(`packages/auth/src/auth.ts`): 10 sign-ins/minute, 5 sign-ups/minute and
5 password-reset requests per 5 minutes per client IP. Explicit limits are
documented, testable and still block credential stuffing.

## 10. Playwright covers the API security scenarios

The required security scenarios are verified with Playwright's `APIRequestContext`
against the running API rather than with mocked unit tests, because that is where
the rules are enforced. See `e2e/tests/security.spec.ts` (13 tests).

## 11. `.env` is symlinked into `apps/web`

Next.js only reads env files from its own project directory. `apps/web/.env` is a
symlink to the repository root `.env` so a single file configures every process.
Both paths are git-ignored.

## 12. Markdown notation for blocks CommonMark has no syntax for

Toggles, columns, a table of contents, page links, media and embeds have no
notation in CommonMark or GFM. Inventing HTML for them was not an option: raw HTML
is rejected on import (ADR-007 and the XSS surface it would open).

They use the generic-directive convention instead, the same one `remark-directive`,
MkDocs and Docusaurus use, implemented as a real markdown-it block rule
(`packages/editor/src/markdown/container-rule.ts`):

```markdown
:::toggle Zusammenfassung
Inhalt
:::
```

Like a code fence the marker may be longer than three colons, which is how
containers nest (`::::columns` around `:::column`). Every container round-trips;
`packages/editor/src/fixtures.ts` covers each one.

## 13. Inline notation for the additional marks

`underline`, `superscript`, `subscript` and a text background have no CommonMark
notation either. They use the widely implemented extensions `++Text++`, `^hoch^`,
`~tief~` and `==hervorgehoben==`, again as real markdown-it inline rules so that
`\==kein Highlight\==` stays literal.

Two are lossy on export, deliberately:

- a **text colour** has no Markdown representation at all and is dropped (the text
  survives);
- a **background colour** is exported as `==Text==` and re-imported as the default
  highlight, so a non-default background loses its exact colour.

Both are view-level styling of unchanged text, which is the one thing Markdown may
lose (ADR-007: Markdown is interchange, not truth).

Mentions use `@[[Seite]]`, `@[Person]` and `@(2026-08-04)`; the page form echoes
the `[[Seite]]` wiki link on purpose.

## 14. Emoji are characters, not a schema node

Tiptap ships an emoji node with a shortcode dataset. Exocortex inserts the Unicode
character as plain text instead: as a character an emoji round-trips through
Markdown perfectly, is found by full-text search, and needs neither a node view nor
a ~1,800-entry dataset in the browser bundle. The picker
(`apps/web/src/components/editor/emoji-menu.tsx`) is a curated list.

## 15. Collapsed headings are decorations, not document structure

A collapsible heading stores one boolean. Which blocks are hidden is derived from
that boolean plus the heading levels on every render and expressed as ProseMirror
decorations (`packages/editor/src/collapsible-heading.ts`).

Moving the section into a wrapper node would have been the obvious alternative and
is wrong twice over: a collaborator with a cursor in the section would have it
remapped under them, and a Markdown export would have to invent nesting the source
never had. The trade-off is that a collapsed block is still in the document and
still in the search index — which is correct, because it is collapsed, not deleted.

## 16. Embeds are restricted to an allow list of hosts

An arbitrary iframe inside a shared document is a script-execution and clickjacking
surface. `packages/editor/src/embed.ts` keeps a list of hosts whose embed endpoints
are meant to be framed; anything else becomes a bookmark card, which loses nothing
a reader needs. Framed content is sandboxed without `allow-same-origin`, so it
cannot reach this origin's cookies or storage.

## 17. Base UI 1.0.0-rc.0: two interaction primitives swallow clicks

Found while getting the editor toolbars to work in a browser, and both cost real
debugging time, so they are recorded here.

**`Toolbar.Button` with a `render` element does not fire the element's `onClick`.**
`<ToolbarButton render={<Button onClick={…} />} />` renders correctly, reports the
right `aria-*`, and does nothing when clicked. The same is true of
`<ToolbarButton render={<Toggle onPressedChange={…} />} />`. The editor toolbars
therefore use plain `Button`s inside the `Toolbar` root: `role="toolbar"` and the
orientation still come from the primitive, and the cost is one Tab stop per control
instead of one for the whole bar. `ToolbarButton` is still used where a menu or
popover trigger owns the click, which works.

**A toolbar button steals the ProseMirror selection on `mousedown`.** Every editor
toolbar button calls `event.preventDefault()` on `onMouseDown`, otherwise the
button takes the focus, the selection collapses, and the command runs against
nothing.

Both are worth re-testing when Base UI reaches a stable release.

## 18. The suggestion menus render from the plugin state, not from the renderer

`@tiptap/suggestion` offers an `onStart`/`onUpdate`/`onExit` renderer for mounting
a popup. It cannot be used together with Tiptap's React menu components.

ProseMirror destroys **every** plugin view whenever the plugin set changes. Tiptap's
`BubbleMenu` and drag handle register their plugins at runtime, so mounting one
tears down the view of every other plugin — including the suggestion's. The
destroyed view calls `onExit`, which unmounts the popup, and its replacement never
calls `onStart`, because ProseMirror only calls `update` on _later_ transactions.
The result: the `/` menu appeared and vanished within the same frame, with no error
anywhere.

The plugin _state_ survives all of that, because it lives in the editor state rather
than in the view. So `apps/web/src/components/editor/suggestion-menu.tsx` reads that
state through `useEditorState` and renders the popup itself, anchored to the
suggestion's own decoration. Only `onKeyDown` still comes from the renderer, because
the plugin dispatches it and is therefore unaffected.

The same rule forced a second split: the component that owns `useEditor` re-renders
into a full option re-apply, which rebuilds all plugin views. `EditorSurface` now
holds no state and subscribes to nothing; everything stateful is in `EditorChrome`.

## 19. `DragHandle` needs a callback with a stable identity

`@tiptap/extension-drag-handle-react` lists `onNodeChange` (and every other
callback prop) in the dependency array of the effect that registers its
ProseMirror plugin, and that effect starts by setting the handle element back to
`visibility: hidden`. An inline arrow function is a new value on every render, so
each hovered block tore the plugin down and rebuilt it: the handle was visible
only between two `mousemove` events and disappeared the moment the pointer came
to rest. `unregisterPlugin` also destroys every _other_ plugin view (see 18), so
the churn reached the suggestion menus as well.

`apps/web/src/components/editor/block-handle.tsx` therefore wraps the callback in
`useCallback` with an empty dependency list and keeps the hovered block in state
that the callback only ever writes through the updater form. While the actions
menu is open the hovered target is frozen in a ref, because reaching the menu
means moving the pointer off the block the actions belong to.

Any further prop of `DragHandle` (`computePositionConfig`, `onElementDragStart`,
`onElementDragEnd`) has to be a module constant or memoised for the same reason.

## 20. The toggle block is styled against its node view, not its HTML

Tiptap's `Details` extension renders native `<details>`/`<summary>` from
`renderHTML` — which is the HTML _export_ path — but a `div[data-type="details"]`
with a `<button>` from its node view, which is what the editor actually shows. The
CSS in `globals.css` therefore targets the node view, and the node view's button is
given its arrow, `aria-expanded` and German label through `renderToggleButton`; it
is empty by default.

## 21. The embedded PDF viewer's toolbar is switched off

A PDF is embedded as `<object type="application/pdf">`, which hands the browser's
own viewer to the reader. In Chromium that viewer offers annotation tools and a
save button, and both lie in this context: the annotations exist only in the tab
and vanish on reload, and "save" writes the original file to disk rather than back
into the document, which reads as _discard my drawing_.

`packages/editor/src/media.ts` therefore appends `#toolbar=0&navpanes=0` to the
source and renders its own header with the two actions that do work, "Öffnen" and
"Herunterladen". Persistent annotations would mean storing them as document
content and painting the pages ourselves; that is a feature to build, not a bug to
fix here.
