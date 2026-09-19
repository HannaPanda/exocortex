# ADR-045: a transclusion is a reference, and it expands exactly once

- Status: accepted
- Date: 2026-09-19

## Context

Issue #78 asks for content that appears in several places while being owned in
one: a status section on both the project page and the overview page, technical
master data embedded in a handful of documents, one checklist maintained
centrally and used all over, a single block referenced without its text being
copied.

The naive implementation is a copy, and it is wrong for a reason that is easy
to state and hard to notice later: a copy is a second original. It reads
correctly the day it is made, drifts the first time somebody edits one of the
two, and there is no moment at which the product could tell anyone that the
drift happened. The same mistake a query block avoids by storing the question
instead of the answer (ADR-042), and the same one a template avoids by keeping
no link back to what it was copied from (ADR-039) -- with the difference that a
template copy is *supposed* to go its own way and a transclusion is not.

Four things then have to be decided, and three of them are only difficult
together:

- **What the reference addresses.** A page is easy. A part of a page needs an
  address that survives editing, and offsets, line numbers and array indexes do
  not (ADR-003). Block identifiers do, and they already exist.
- **Where the content comes from.** If it is not in the embedding document, it
  is read at read time -- and then the question is whose permissions apply.
- **Cycles.** Page A embeds B, B embeds A. This is not exotic; two pages that
  cross-reference each other is the normal shape of a wiki.
- **What an export carries.** `:::transclusion Titel^block` means nothing
  outside this deployment, and a file that leaves has to stand on its own.

## Decision

**A transclusion stores a reference and no content.** The `transclusion` node
carries `documentId` (the identity), `label` (the source's title, for display
and export) and `sourceBlockId` (the addressed block, or `null` for the whole
page). Nothing of the source is in the embedding document: not in the Yjs
state, not in the ProseMirror JSON, and not in the plain text the search index
and the embeddings are built from. So the same paragraph is weighed once, where
it lives, however many pages show it -- which is the "Suchindex darf denselben
Inhalt nicht unkontrolliert mehrfach gewichten" requirement, satisfied by the
absence of a mechanism rather than by one.

**A heading addresses its section.** The heading plus everything under it, up
to the next heading of the same or a higher level among its siblings. Any other
block addresses itself and its children. Without this rule the first example in
the issue would not work: a status section is a heading and the paragraphs
beneath it, and a reference to the heading alone would have to be re-picked
every time somebody adds a paragraph.

**The content is read at read time, as the reader.** One route,
`GET /api/documents/:documentId/fragment`, goes through the ordinary
`canReadDocument` policy. So the source's permissions apply at the place of the
embedding without the node, the editor or the page knowing anything about
permissions, and somebody who may not open the source sees *that* something is
embedded, never what. The browser calls it per placed block while it renders;
the materialized export calls it for all of them at once. Both go through
`DocumentFragmentService`, so the authorization is written once.

**One level, everywhere.** A transclusion inside a fragment is shown as the
reference it is and is never resolved further -- in the browser, in the export
and in the MCP tool. This is the answer to cycles, and it is deliberately not
cycle *detection*: a depth limit, a visited set travelling with the request or a
refusal at insertion time would all have to be right in three places and would
each be a thing that can be got wrong. One level cannot loop. Two pages that
embed each other both render, each showing the other's text with the way back
named but not followed. What is lost is a chain of embeddings, which no example
in the issue asks for; what is gained is that no reader, exporter or indexer can
be sent around a loop by content somebody wrote.

The one case one level does not cover is a page embedding *itself*, which would
not loop but would show the page inside itself. That is refused outright, in the
node view and in the export.

**Dead references are stated, never repaired.** A block identifier that no
block on the source carries any more answers `resolved: false`, and the block
says so and offers to show the whole page instead. It never falls back to the
nearest surviving block: a transclusion that quietly starts showing a different
paragraph is worse than one that says it is broken. A source that was deleted or
that this reader may not open is the same kind of visible state. The reference
itself is kept in all of these cases, so nothing is silently lost and the
reference comes back when the source does.

**Markdown addresses the source by title, like every other reference.**
`:::transclusion Titel^blockid`, in the container syntax every custom block
uses. The identity is not written -- the rule `pageLink` follows (ADR-014's
interchange principle, issue #14): an exported file contains no internal
document ids, and an import binds the title back to a document through
`bindPageLinkIdentities`. The block identifier *is* written, because it is the
address of the part and nothing else names it.

**The export chooses.** `GET …/export/markdown?transclusions=text` puts the
source's text in place of the references; the default, `reference`, leaves them
alone. A file that comes back here should keep pointing at the one page that
owns the text; a file that leaves has to carry what it shows. What does not
resolve stays a reference either way, because an export must never be the place
where a broken reference turns into missing content.

**Editing at the place of the embedding is not part of this.** Issue #78 says
so explicitly ("synced blocks ... können später folgen"), and the read-only
rule is what keeps the canonical state unambiguous: one document owns the
block, and a write reaches it through that document's collaboration session
(ADR-016) like every other write.

## Consequences

- A transclusion is as fresh as the source's *materialization*, not as its
  open editing session. Typing in the source's editor reaches the embedding
  page when that page's cached fragment is invalidated, which happens on
  `document.materialized` and on every write from outside the editor. Live
  keystroke-by-keystroke mirroring would mean a second collaboration
  subscription per embedded block, which is a cost with no example behind it.
- Rendering the fragment costs a read of the source per block on the page.
  Cached for fifteen seconds in the browser and capped at
  `MAX_MATERIALIZED_TRANSCLUSIONS` per export.
- The browser renders the fragment with a second, read-only editor over the
  canonical schema rather than with a Markdown renderer. A renderer of its own
  would be a second rendering of one document, free to drift from the first; a
  checklist would stop being a checklist on the way.
- `exo_page_block_read` is useful well beyond transclusion: it is how an agent
  reads one section of a long page instead of sixty thousand characters of it.
- Backlinks do not yet count a transclusion. The reference index
  (`extractDocumentLinks`) knows `pageLink`, `mention` and `wikiMark`; adding a
  fourth kind means a database enum value and a migration, and it is a separate
  change from making the block work.

## Alternatives considered

- **Copy the content into the embedding document and keep it in sync.** This is
  "synced blocks", and it needs a propagation job, a conflict rule for the case
  where both copies were edited, and an answer for what happens when the source
  is deleted. Issue #78 asks for clean transclusion first for exactly this
  reason.
- **Resolve to arbitrary depth with a visited set.** Detects cycles instead of
  preventing them, and has to be implemented identically in the node view, the
  export and the tool. Three places that have to agree, versus one rule.
- **Address a block by a heading's text instead of its identifier.** Readable in
  the file, and broken by the first typo fix in the heading.
