# Page templates

Issue #79, [ADR-039](adr/ADR-039-a-template-is-a-page-you-copy.md).

Not the render templates of [`docs/render.md`](render.md). Those turn a page
into a PDF; these turn nothing into a page.

## What a template is

An ordinary page with a row in `document_template`. The page is the content,
the icon, the cover and -- when it sits in a database -- the row properties.
The sidecar holds the four things a copy needs and a page has nowhere to keep:

| Column                   | Meaning                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `description`            | One line, shown under the title in the picker                           |
| `titlePattern`           | What the copy is called, with `{{...}}` placeholders                    |
| `targetParentId`         | Where a copy lands when the caller names no parent; `SetNull` on delete |
| `useCount`, `lastUsedAt` | What the picker sorts by                                                |

There is no template id. Everything addresses a template by the `documentId`
of the page it is.

## Using one

`POST /api/templates/:documentId/pages` →
`TemplatesService.instantiate`:

1. The title comes from `renderTitlePattern` (in `@exocortex/contracts`) with
   the workspace's `calendar.timeZone`. A `title` in the request overrules the
   template's own and is what `{{titel}}` stands for.
2. The content is read as canonical Yjs state, turned into ProseMirror JSON and
   run through `copyDocumentForNewPage` (in `@exocortex/editor`), which
   regenerates every block id and leaves every outward reference alone.
3. `DocumentsService.create` makes the page with that state as
   `initialYjsState`, which is only sound for a page that does not exist yet.
4. The cover is set with a second `documents.update`, because that is the one
   place an attachment is checked for being usable as one.
5. Row properties are copied when -- and only when -- the new page's parent is
   the same collection the template sits in.
6. `useCount` goes up and `lastUsedAt` moves.

The response names what could not be copied exactly: attachments still belong
to the template, and an embedded database is now shown twice.

## Adding a placeholder

1. Add it to `TEMPLATE_TITLE_PLACEHOLDERS` in
   `packages/contracts/src/template-title.ts`, with the German description the
   UI and the MCP tool description both read from it.
2. Produce its value in `partsIn`, from `Intl` in the caller's zone. Never from
   `Date` getters: the server runs in UTC.
3. Add a case to `packages/contracts/src/template-title.test.ts`.

Nothing else changes: the browser's preview, the settings dialog's hint line
and `exo_template_create`'s description are all generated from the same map.

## Where it is in the UI

- **Sidebar, `+` menu → "Seite aus Vorlage"** opens
  `components/shell/template-picker-dialog.tsx`.
- **Page menu → "Vorlage …"** opens
  `components/shell/template-settings-dialog.tsx`, which marks the open page,
  edits the two fields or unmarks it again.

Both talk to `lib/api/template-queries.ts`.

## What this deliberately does not do

A page made from a template keeps no link back, so there is no way to ask which
pages came from a template and no way to push a change into them. Adding either
means adding that link, and ADR-039 explains why it is not there.
