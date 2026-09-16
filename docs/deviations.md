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
  `@base-ui/react`
- the `radix-ui` dependency the CLI added was removed again

The result contains no Radix code. See `docs/ui-system.md`.

The four version choices below were re-checked against the registry, the first
three on 2026-09-15 and all four on 2026-09-16, and reasons keep expiring: two
of the three original ones had already gone. A reason for staying on an old
major ages faster than anything else in this file, so each one says what was
measured and how, not what was believed at the time.

## 2. Prisma 6 instead of Prisma 7

Prisma 6.19.3. The 7 line is at 7.10.0 and the `latest` dist-tag has already
moved on to `8.0.0-rc.15`.

The original reason is gone: Better Auth was said to be tested against 6, but
`better-auth@1.6.33`, the version installed here, declares
`prisma`/`@prisma/client`: `^5.0.0 || ^6.0.0 || ^7.0.0`, and so does 1.7.5.

What does hold it back is that 7 is not the contained change this entry used to
promise. Generating this schema against `prisma@7.10.0` shows two hard breaks:

- `datasource db { url = env("DATABASE_URL") }` is a validation error (`P1012`).
  Connection URLs move into a `prisma.config.ts`.
- `new PrismaClient()` with no options throws a
  `PrismaClientInitializationError`: a driver adapter is now required to connect
  to the database at all. A direct connection means `@prisma/adapter-pg` and a
  changed `packages/database/src/client.ts`.

The `prisma-client-js` generator with an explicit `output` still works under
7.10.0, so that half of the original reasoning survives. The upgrade is a day of
work in one package, not an afternoon, and it has to be done deliberately rather
than as a side effect of a dependency bump.

## 3. TypeScript 5.9 instead of TypeScript 7

TypeScript 5.9.3. 7.0.2 is the current release and it is the native port: the
package ships platform binaries as optional dependencies and a `getExePath`
shim rather than a JavaScript compiler.

One blocker, and it is decisive. `typescript-eslint` peers
`typescript: >=4.8.4 <6.1.0`, in 8.70.0, the newest release and the one
installed here. That rules out the 6 line as well as the 7 line, and this
repository lints with type information, so there is no version of this where the
compiler moves ahead of the linter.

The other two reasons this entry used to give are not blockers:

- NestJS decorator metadata is fine. `tsc` 7.0.2 compiles a decorated class with
  an injected constructor parameter under `experimentalDecorators` and
  `emitDecoratorMetadata` and emits `design:paramtypes` as before.
- `next`'s type plugin was not re-tested, so it is not claimed either way here.

## 4. ESLint 9 instead of ESLint 10

ESLint 9.39.5. 10.10.0 is current, and 9.39.5 is now what the registry tags
`maintenance`, which puts a clock on this one.

The culprit this entry used to name has been cleared: `typescript-eslint` peers
`eslint: ^8.57.0 || ^9.0.0 || ^10.0.0` in 8.70.0, which is installed here.

The one plugin still holding the line is `eslint-plugin-react`, whose newest
release, 7.37.5, peers `eslint: … || ^9.7` and has no 10 range. Upgrading also
pulls `@eslint/js` to 10.x, which peers `eslint: ^10.0.0`. Nothing else in
`eslint.config.mjs` objects: `eslint-plugin-react-hooks@7.1.1` already lists
`^10.0.0`, and `eslint-config-prettier` and `eslint-plugin-simple-import-sort`
have open ranges.

## 5. better-auth 1.6 instead of better-auth 1.7

better-auth 1.6.33, the head of the maintained `release-1.6` line. 1.7.5 is
`latest`.

The reason is one import. `packages/auth/src/auth.ts` builds the OAuth 2.1
authorization server for remote MCP clients (ADR-018) out of better-auth's
`mcp` plugin. In 1.7 that plugin left the package: it is `@better-auth/mcp`
now, and it is not the same plugin under a new name. It is a different
authorization server.

What changes with it, measured against `@better-auth/mcp@1.7.5`:

- `oidcConfig` is gone. The plugin used to wrap better-auth's OIDC provider and
  took its options through that field, which is where `consentPage`,
  `requirePKCE` and both token lifetimes are set here. 1.7 is built on
  `@better-auth/oauth-provider` and takes a flat option object instead.
- `resource` is required and audience-binds every token it issues (RFC 8707 /
  RFC 9728). eXocortex has no such identifier today.
- Dynamic client registration is opt-in. This deployment relies on it: ChatGPT
  cannot spawn the stdio bin and registers itself. It now means either the
  `cimd()` plugin or explicitly enabling the provider's registration options,
  and Client ID Metadata Documents change what the consent screen is deciding
  about.
- Access tokens become JWTs verified against a JWKS. `verifyMcpAccessToken`
  reads `oauth_access_token` by value, which is exactly what ADR-018 says the
  MCP endpoint does instead of trusting the plugin's typing.

Each of those reaches the consent screen at `/verbinden`, which is the actual
gate in front of an open registration endpoint, or the token path that
`/api/mcp` authenticates with. That is a migration with its own acceptance
criteria, not a version number, and it is issue #64.

Staying on 1.6 is not standing still: `release-1.6` is a maintained line and
1.6.33 is its head. What it does cost is that the 1.6 line will stop being
maintained one day, and the migration has to happen before then rather than
after.

## 6. Redis event bus instead of the Socket.IO Redis adapter

**Brief:** "Create a Redis adapter boundary for future horizontal scaling."

**What was done:** `packages/queue/src/event-bus.ts` implements a validated Redis
pub/sub bus. Every process publishes application events to one channel and every
API instance re-emits them into its local Socket.IO rooms. This covers the same
scaling boundary, additionally lets the _worker_ publish events (which the
Socket.IO adapter cannot), and validates payloads on both ends. Using both
mechanisms at once would double-deliver events.

## 7. Block identifiers in Markdown are opt-in

**Brief:** "preserves IDs during export where the format allows it."

Markdown has no attribute syntax. `serializeMarkdown(doc, { includeBlockIds: true })`
writes an Obsidian-compatible `^id` suffix, and the parser reads it back.
The default export omits identifiers so exported files stay clean. Round-tripping
with identifiers is covered by
`packages/editor/src/markdown/markdown.test.ts` → "preserves block ids when they
are included in the export".

Container nodes (lists, tables) do not carry an id in Markdown; paragraphs,
headings, code blocks, list items, task items and callouts do.

## 8. MIME detection is implemented locally

`file-type` is ESM-only, which does not combine with the CommonJS builds of the
API and worker. `packages/storage/src/mime.ts` implements a short, auditable
signature table for exactly the formats eXocortex allows, plus a UTF-8 text check.
It is covered by 11 unit tests, including "rejects an executable disguised as an
image".

## 9. `packages/ui` and `packages/editor` are consumed as source by the browser

Both are listed in `transpilePackages`. For `packages/ui` this lets Tailwind see
the class names. For `packages/editor` it is a correctness requirement: mixing its
CommonJS build into the ESM browser bundle produces two ProseMirror module
instances, which makes ProseMirror reject plugins with
"Adding different instances of a keyed plugin". Server processes keep using the
compiled CommonJS output through the `require` condition.

## 10. Explicit authentication rate limits

Better Auth's defaults were replaced with an explicit policy
(`packages/auth/src/auth.ts`): 10 sign-ins/minute, 5 sign-ups/minute and
5 password-reset requests per 5 minutes per client IP. Explicit limits are
documented, testable and still block credential stuffing.

## 11. Playwright covers the API security scenarios

The required security scenarios are verified with Playwright's `APIRequestContext`
against the running API rather than with mocked unit tests, because that is where
the rules are enforced. See `e2e/tests/security.spec.ts` (13 tests).

## 12. `.env` is symlinked into `apps/web`

Next.js only reads env files from its own project directory. `apps/web/.env` is a
symlink to the repository root `.env` so a single file configures every process.
Both paths are git-ignored.

## 13. Markdown notation for blocks CommonMark has no syntax for

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

## 14. Inline notation for the additional marks

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

## 15. Emoji are characters, not a schema node

Tiptap ships an emoji node with a shortcode dataset. eXocortex inserts the Unicode
character as plain text instead: as a character an emoji round-trips through
Markdown perfectly, is found by full-text search, and needs neither a node view nor
a ~1,800-entry dataset in the browser bundle. The picker
(`apps/web/src/components/editor/emoji-menu.tsx`) is a curated list.

## 16. Collapsed headings are decorations, not document structure

A collapsible heading stores one boolean. Which blocks are hidden is derived from
that boolean plus the heading levels on every render and expressed as ProseMirror
decorations (`packages/editor/src/collapsible-heading.ts`).

Moving the section into a wrapper node would have been the obvious alternative and
is wrong twice over: a collaborator with a cursor in the section would have it
remapped under them, and a Markdown export would have to invent nesting the source
never had. The trade-off is that a collapsed block is still in the document and
still in the search index — which is correct, because it is collapsed, not deleted.

## 17. Embeds are restricted to an allow list of hosts

An arbitrary iframe inside a shared document is a script-execution and clickjacking
surface. `packages/editor/src/embed.ts` keeps a list of hosts whose embed endpoints
are meant to be framed; anything else becomes a bookmark card, which loses nothing
a reader needs. Framed content is sandboxed without `allow-same-origin`, so it
cannot reach this origin's cookies or storage.

## 18. Toolbar buttons keep one workaround of the two they had

Two faults were recorded here while getting the editor toolbars to work in a
browser, both against Base UI 1.0.0-rc.0. Both were re-measured on 2026-09-15
against 1.8.0, the first stable release after the package rename (issue #60),
and they did not age the same way.

**Fixed: `Toolbar.Button` with a `render` element swallowed the click.**
`<ToolbarButton render={<Button onClick={…} />} />` rendered correctly, reported
the right `aria-*`, and did nothing when pressed. Under 1.8.0 it fires, which the
e2e case `formats a selection through the toolbar` proves in a real browser. The
workaround is gone: the selection toolbar, the table toolbar and the link bubble
are back on `ToolbarButton`, menu and popover triggers included.

**Still needed: a toolbar button steals the ProseMirror selection on `mousedown`.**
Every command button still calls `event.preventDefault()` in `onMouseDown`,
otherwise the button takes the focus, the selection collapses, and the command
runs against nothing. This was never Base UI's to fix and 1.8.0 does not pretend
otherwise: `useButton` forwards `onMouseDown` untouched and prevents nothing. The
default it would have to suppress is the browser's own focus-on-press, and a
primitive that suppressed it for everyone would break text selection inside a
toolbar.

**New, and the reason the first fix alone bought nothing:** a `Toolbar` inside
Tiptap's `BubbleMenu` gets no roving tabindex at all. `CompositeList` builds the
order from the items' document position and skips every registration whose node
is not connected, which is the only sane reading of a node that has no position.
`BubbleMenu` portals its children into a `document.createElement('div')` and
appends that div when its ProseMirror plugin view is created, one effect after
the children mounted and the composite had already flushed. Every control then
renders `tabindex="-1"` and `role="toolbar"` promises a Tab stop it does not
have. `packages/ui/src/components/ui/toolbar.tsx` remounts its children once its
root is connected, which re-runs the item ref callbacks and flushes the composite
against nodes it will not skip; a toolbar that is already in the document when it
mounts never enters that loop. The e2e case `the selection toolbar is a single
tab stop with arrow-key navigation` is what keeps it honest.

## 19. The suggestion menus render from the plugin state, not from the renderer

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

## 20. `DragHandle` needs a callback with a stable identity

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

## 21. The toggle block is styled against its node view, not its HTML

Tiptap's `Details` extension renders native `<details>`/`<summary>` from
`renderHTML` — which is the HTML _export_ path — but a `div[data-type="details"]`
with a `<button>` from its node view, which is what the editor actually shows. The
CSS in `globals.css` therefore targets the node view, and the node view's button is
given its arrow, `aria-expanded` and German label through `renderToggleButton`; it
is empty by default.

## 22. The embedded PDF viewer's toolbar is switched off

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

## 23. The icon and emoji datasets are generated into the repository

`packages/contracts/src/lucide-icon-names.ts`,
`apps/web/src/components/document/lucide-icon-nodes.generated.ts` and
`apps/web/src/lib/emoji-data.generated.ts` are written by
`pnpm data:generate` (`scripts/generate-icon-data.mjs`,
`scripts/generate-emoji-data.mjs`) out of `lucide-react` and `emojibase-data`, and
they are committed rather than built on the fly. Two reasons: the build must not
depend on a package the runtime does not use, and a dataset that changes only when
a dependency is upgraded should change in a diff someone can read.

Both generated data modules are one `JSON.parse` of a single string literal. As an
object literal, TypeScript would infer a type for all 1,756 icons and the engine
would parse half a megabyte as source; as a string it is one token to both, and
the bytes on the wire are the same. They are excluded from Prettier and ESLint —
reformatting them costs seconds and nobody reads them.

## 24. The page tree drags with the platform, not with a library

Reordering pages in the sidebar is native HTML5 drag and drop
(`apps/web/src/components/shell/page-tree.tsx`) rather than `dnd-kit` or
`react-dnd`. The tree is one column of rows with three drop zones each — before,
into, after — which `dragover` plus the pointer's offset inside the row already
answers. A drag-and-drop library is a second interaction framework to keep in step
with Base UI and the design system, and it would be carrying a sortable-grid
engine to draw one amber line.

The price is that native drag has no keyboard story at all. That is why the four
`Alt`-plus-arrow commands in the row's context menu are not a convenience here but
the other half of the feature: they are how the tree is reordered without a mouse,
and they go through the same `POST /api/documents/:id/move` with the same sibling
anchors. Touch is the same story — a long press opens the context menu, and the
commands are there.
