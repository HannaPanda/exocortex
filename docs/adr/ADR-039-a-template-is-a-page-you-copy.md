# ADR-039: a template is an ordinary page, and using it is a copy

- Status: accepted
- Date: 2026-09-18

## Context

Issue #79 asks for page templates: a meeting note, a research page, an
incident, a weekly review. The structure of those pages is the same every
time, and rebuilding it by hand is both tedious and unreliable -- the fourth
meeting note has a heading the first three do not.

The repository already has something called a template (issue #44, ADR-026):
the Pandoc templates a page is rendered through. Those turn a page into a PDF.
These turn nothing into a page. The two never meet, and the name collision is
the first thing anybody reading the code will trip over.

Three questions decided the shape.

**What is a template made of?** The obvious answer is "a document plus some
metadata", and the tempting one is a new model that holds a body, a title
pattern and a set of default properties. That model then needs its own editor,
its own search, its own permissions and its own place in the MCP catalogue,
because the thing people edit most about a template is its content -- and its
content is a page.

**Where do templates live?** A hidden shelf is the usual answer: a list in a
settings screen, or a reserved page nobody may move. Both introduce a second
kind of place into a product whose entire structure is "pages under pages".

**What is the relationship between a template and a page made from it?** A live
one -- a page that keeps following its template -- is a different feature with
a much larger blast radius: every template edit would have to reach every page
derived from it through the collaboration server, and every local edit to such
a page would have to survive the next template change. Issue #79 explicitly
asks for the opposite.

## Decision

**A template is an ordinary page carrying a `DocumentTemplate` sidecar row.**
The same shape as `MemoryFact` (ADR-021) and the same reasoning as
`Document.isInbox` (ADR-036): the page stays a page, so the editor, search,
references, snapshots, moving, renaming, exporting and every permission check
work on a template without a single branch. The sidecar holds only what a copy
needs and a page has nowhere to keep: a one-line description for the picker, a
title pattern, a suggested target parent, and how often the template has been
used.

**Templates live wherever their pages live.** A workspace that wants them in
one place makes a page called Vorlagen and moves them under it, the way it
would organise anything else. They are visible in the tree and findable in
search, and that is a consequence of the decision above rather than an
oversight: hiding them would require a second kind of invisibility the tree
does not have.

**Using a template is a copy, and the copy keeps nothing.** There is no link
back, no `templateId` on the new page, no propagation. The copy is built from
the template's canonical Yjs state rather than from its Markdown, because
Markdown is an interchange format (ADR-007) and would quietly drop the database
embeds, callouts and columns that are half the reason to have a template. The
new page is created with that state already in hand: `DocumentsService.create`
takes an optional `initialYjsState`, which is sound precisely because the page
does not exist yet -- it has no history to merge with and nobody has it open.
Handing finished binary state to a page that already exists is the mistake that
duplicated content once before; a write to an existing page still goes through
`DocumentContentService.write`, which edits the state and tells the open
session (ADR-004/005, ADR-016).

**Block ids are regenerated, references are not.** A block id is a stable
address (ADR-003) that comment anchors and the reference index resolve, so two
pages carrying the same id would turn every such lookup into a question with
two answers. Everything pointing outwards -- links, mentions, embedded
databases, attachments -- is kept exactly as it was, because it names something
that exists once and is not being copied. The two cases where that surprises
somebody are named in the response: an attachment still belongs to the
template, and an embedded database is now shown on two pages.

**Row properties are copied only within one database.** A `DocumentPropertyValue`
names a `DatabaseProperty` of one collection. Copying it into a different
database would either point at a column that does not exist or match one by
name, and matching by name is how the wrong date ends up in the wrong field.
Across databases the copy is made without its properties and the caller is told
so.

**The title pattern is one pure function in `@exocortex/contracts`.**
`renderTitlePattern` is called by the API to build the real title and by the
browser to preview it while it is being typed; a second implementation in the
client would drift the day somebody adds a placeholder. Date placeholders are
read in the workspace's `calendar.timeZone`, because the server runs in UTC and
`{{datum}}` means the date of the person creating the page. An unknown
placeholder is left standing rather than replaced by nothing, so a typo is
visible as a typo.

## Consequences

- One new table, `document_template`, and one new nullable option on
  `DocumentsService.create`. No new document type, no new content model.
- Five MCP tools (`exo_template_list`, `_create`, `_update`, `_delete`,
  `_use`), all on both agent surfaces, all addressing a template by the
  `documentId` of the page it is. There is no template id, and the tool
  descriptions say so.
- A template appears in the page tree and in search results. That is the price
  of it being a page, and it is the same price the inbox pays.
- A page made from a template is indistinguishable from one made by hand. That
  is the feature; it also means there is no way to ask "which pages came from
  this template", and answering that later would need a link this decision
  deliberately does not create.
- Deleting a template deletes nothing that was made from it. Unmarking one
  (`DELETE /api/templates/:documentId`) deletes neither the page nor its
  copies.
