# ADR-058: a semantic hit carries the section it came out of

- Status: accepted
- Date: 2026-09-21

## Context

ADR-056 made a large page cheap to read and ADR-057 kept it from growing
without anybody noticing. Both assume the reader knows which part of the page
it wants. Search is where that is decided, and search could not say.

A hit named the page, its path and a snippet. On a page of two thousand
characters that is an answer; on "Gesundheit" with 36,257 it is the thing the
caller already knew. The run behind issue #118 is the proof: fourteen searches
with fourteen different word combinations, every one of them answering with
the page it had just read, none of them saying where in it the words were.

Two halves of the search have very different answers available.

**The semantic half already knows.** Since ADR-034 a long page is embedded as
passages of about two thousand characters, the passage text is stored beside
the vector, and the winning passage is what the snippet is cut from. What was
missing was one fact about that passage: which heading it sits under.

**The keyword half does not.** A `tsquery` match is a position in a
`tsvector`, and nothing maps that position back onto a block. That needs an
offset-to-block table built during materialization, which is work the context
compiler in issue #110 needs as well. Building it here would have tied this
fix to that one.

## Decision

**A passage vector stores the heading above it, and a hit carries it as
`section`.** Two columns on `document_embedding`: `headingBlockId`, the
address to read the section with, and `headingPath`, the heading and the
headings it sits under. `SearchResult.section` is `null` when the hit is not
located, which is a statement and not an omission: a keyword-only match says
so rather than pointing at the top of the page.

**The anchor is computed where the page's structure is, and nowhere else.**
`plainTextHeadingAnchors` in `@exocortex/editor` returns the headings with the
character offset of each in the plain-text projection, out of the same
assembly that produces the projection itself -- so an offset cannot drift away
from the text it points into. The indexer reads the stored ProseMirror JSON
for it rather than deserializing the canonical Yjs state: indexing runs on
every save, and a 2.9 million character page would make the cheap half of the
job the expensive one.

**The anchor is not part of the hash.** What is embedded is unchanged, so a
passage that gains a heading must not cost a second embedding call. A write
whose text hash matches but whose heading differs updates two columns and
leaves the vector alone. That is also what makes the backfill affordable:
`backfill-passage-anchors` enqueues ordinary re-indexing, ten minutes apart,
and pays the model nothing.

**"Nobody worked it out" and "there is no heading" are different values.**
`NULL` is the first, `[]` the second. With one value the sweep could not tell
a page it still owes an anchor from a page without headings, and would come
back to every flat page forever.

**Fusion keeps the keyword snippet and the semantic section.** A page both
halves found keeps the highlighted fragment a reader wants and gains the
address an agent needs; they come from different halves and neither has to
lose.

**Attachment text sits under no section.** The search projection appends what
was extracted from a page's attachments (issue #101), and those characters
belong to no heading of the page. The indexer marks the boundary with an
anchor carrying an empty path, so a passage out of a PDF says nothing rather
than claiming the page's last heading.

## Consequences

An agent that searches gets an address. `exo_search` prints the section and
its block identifier, `exo_page_block_read` opens exactly that, and the loop
that produced this issue -- search, read the whole page, search again -- has
no reason to start.

A keyword-only hit stays unlocated until issue #110 builds the offset-to-block
table. That is visible in the contract rather than hidden: `section: null` is
what a caller sees, and the sentence saying why is in the schema.

A page indexed before this change answers without a section until the sweep
reaches it, which takes ten minutes per 200 pages and costs no model call. A
page whose content has never been materialized keeps `NULL` and is picked up
after the next materialization, because the anchors are read off the derived
JSON.

The whole-document vector carries no anchor at all. It stands for the page,
not for a part of it, and `findRelated` (ADR-020) compares pages -- so a
related-pages answer is about pages and says nothing about sections.
