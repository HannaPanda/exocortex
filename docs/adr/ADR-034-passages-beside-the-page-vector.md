# ADR-034: a long page is embedded as passages, beside its whole-document vector

- Status: accepted
- Date: 2026-09-18

## Context

ADR-020 embeds a page as one vector, built from its title and the first 24000
characters of its text. Issue #36 is the question of whether that is enough,
measured on this installation rather than guessed:

```
2031 Seiten, Schnitt 1493 Zeichen
1994 unter  4k Zeichen   → eine Seite = ein Gedanke, ein Vektor passt
  36 zwischen 4k und 24k
   1 über   24k Zeichen
```

For 98 percent of pages one vector is the truth. It stops being the truth
exactly where it costs the most, because the longest pages are also the ones
that get asked about most often: the security audit, the calendar plan, the
setup pages. A page of twenty thousand characters about twenty subjects becomes
the average of twenty subjects, and the average is about nothing.

There is a second, sharper reason, and it is about the reader rather than the
ranking. A vector hit today returns the first 200 characters of the page as its
excerpt. An agent calling `recall` with a small context window does not want
three page beginnings, it wants the three paragraphs that answer the question.
Without passages the index has no idea which paragraph that was.

Three things had to be decided.

**What is a passage?** ADR-003 gives every block an identity, so a block is the
obvious boundary. It is also too small: a single paragraph is usually a few
dozen words, and a vector built from a few dozen words is dominated by whichever
words those happen to be.

**Do the passages replace the page's vector?** The `blockId` column and its
`NULLS NOT DISTINCT` unique index were written for per-block rows from the
start, so replacing would have been the reading of the schema.

**Who catches up?** A page that nobody edits is never re-indexed, so an
improvement that only happens while writing is an improvement that never
happens to the archive.

## Decision

**A passage is a run of blocks packed to about 2000 characters, with an
overlap.** `chunkPlainText` (`packages/database/src/chunking.ts`) cuts at the
newlines that `plainText` puts between top-level blocks, packs blocks up to the
target, repeats about 200 characters of the previous passage at the start of the
next one so a thought that straddles a boundary is in some vector whole, and
appends a remnant shorter than 400 characters to the passage before it instead
of giving it a row of nobody's business. A block longer than a whole passage (a
pasted transcript, a table serialised into one line) is cut at word boundaries
first. The row is stored under `blockId = 'chunk:0000'`, `'chunk:0001'` and so
on: a run of blocks is not a block, so it carries a key of its own rather than
borrowing a block identity it does not have.

**The passages are added beside the whole-document vector, not instead of it.**
Two things depend on a page having one vector. `findRelated` (issue #33) asks
"what resembles this page", which is a question about pages; answered from
passages it would return one page's own paragraphs. And a page is more than the
sum of its paragraphs: what it is about is often in no single one of them.
A page below 2400 characters is not cut up at all, so 98 percent of this
installation keeps exactly the row it had.

**A search reads the nearest rows and folds them to one per page.** The vector
query over-samples by three, takes the best row per `documentId`
(`DISTINCT ON`), and hands that to the rank fusion, which has never known about
anything but pages. Without the fold a thorough page would own the whole result
list with its own paragraphs. The winning row carries its passage, which becomes
the excerpt — so a hit now shows the paragraph that matched, and `recall` puts
that in the agent's context instead of the first lines of the page.

**The passage is stored, not recomputed.** `document_embedding.chunkText` holds
the text the vector was built from. Character offsets into
`document_search_index.plainText` would have been cheaper and would have been
wrong at the only moment that matters: the packing may already have been redone
against a newer text, and the excerpt would then point at a sentence that is not
there any more, silently.

**Catching up is the backfill's job.** `backfill-embeddings` already looks for
pages without a whole-document vector; it now also picks up pages above the
threshold that have one but no passages. Turning chunking on is the same kind of
event as turning semantic search on, and nothing else would ever revisit a page
that nobody is editing.

## Consequences

- The vector index grows by roughly the long pages' share of the text, not by
  ten times the row count: only 2 percent of pages are cut up at all.
- One page can contribute at most 64 passages, about 128000 characters. Beyond
  that the page is only in the index through its full-text row, which sees all
  of it. The one 2.1 million character page in this installation stays a
  full-text matter, as it already was.
- `textHash` is per row, so an edit re-embeds the passages it touched rather
  than the page. Greedy packing means an edit can still shift the boundaries
  after it, so "the passages it touched" is an honest majority, not a guarantee.
- An excerpt can now repeat a sentence from the end of the previous passage,
  because the overlap is part of the stored text. That is the price of not
  losing a thought at a boundary.
- `findRelated` is unchanged, by construction: it filters `blockId IS NULL` and
  always did.
- A search costs the same as before: one embedding of the query. Only indexing
  and the size of the table grew.
