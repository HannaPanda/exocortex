# ADR-100: a keyword hit is located through a block map stored with its text

- Status: accepted
- Date: 2026-11-28
- Amends: [ADR-058](ADR-058-a-hit-carries-the-section-it-came-from.md)

## Context

ADR-058 gave a semantic hit the section it came out of and left a keyword hit
unlocated on purpose: a `tsquery` match is a position in a `tsvector`, and
nothing mapped that position back onto a block. It expected the context
compiler of issue #110 to build an offset-to-block table; #110 closed without
one (ADR-061 borrows the heading of a passage vector instead).

The cost of that gap showed up in issue #274. A word stood in the second of two
long lists on one page. The search named the page and nothing else, the
built-in AI read the first list, did not find the word there and reported the
entry as lost. The keyword half is the half a person and an agent use when they
know the word, which is exactly when they expect to be told where it is.

## Decision

**The indexer stores a block map beside the search projection, in the same
write.** `document_search_index.blockMap` is a JSONB value of parallel arrays
(`StoredSearchBlockMap` in `packages/database/src/search-block-map.ts`): the
offset each unit starts at, its block, the section it sits in and, for text out
of an attachment, which file. Written in the same upsert as `plainText`, so the
text a snippet is cut from and the map a hit is located with can never belong
to two versions of the page. One column on an existing row rather than a table
of one row per block, because indexing runs on every save and a page of three
thousand list points would otherwise delete and insert three thousand rows
each time.

**A unit is a top-level block or a list point.** Since #274 a list point is
addressable on its own, and a long list is exactly where "the block" is too
coarse. Points are units at every depth, and the text of a point after its
nested list is the point's again. Other containers (a table, a toggle,
columns) are one unit: the block that holds the words is named, never a wrong
one. A child is placed only where its container's plain text really is its
children joined line by line; an adapter that adds text of its own keeps its
children unplaced instead of placed at a guessed offset.

**The map comes out of the plain-text assembly itself.** `plainTextBlockMap`
in `@exocortex/editor` renders the parts once, records where each unit starts
and carries those offsets through the same cleanups the text goes through,
like `plainTextHeadingAnchors` does. The indexer trusts it only when its text
equals the stored `plainText`; otherwise the page's own text stays unlocated.
Offsets are stored in code points, because that is what PostgreSQL's `strpos`
and `length` count: one emoji before a hit would otherwise move every
location after it.

**The hit is located from the snippet, so the two cannot disagree.**
`ts_headline` runs with private-use characters as highlight and fragment
markers; the first fragment, markers stripped, is found in `plainText` with
`strpos`, and the first highlighted word inside it is the hit's offset. The
last unit starting at or before it is the answer. The markers are turned back
into `<mark>` and `...` afterwards, so the snippet a reader sees is
unchanged. A fragment that cannot be found again (a title-only match, a text
the parser reproduced differently) leaves the hit unlocated: `null`, never a
guess.

**A hit in an attachment names the file.** The search projection appends the
text of a page's attachments (ADR-050). Each attachment's text is a unit of its
own carrying `attachment` (id and file name) and, when a block on the page
shows that file, that block. No section: attachment text sits under no heading
of the page, as ADR-058 already says for passages.

**The contract grows two fields and keeps `section` meaning the heading.**
`SearchResult.blockId` is the block the words stand in and `attachment` the
file. A hit is unlocated when all three are `null`. Fusion keeps a located
keyword hit's location whole and only borrows the semantic section for a page
the keyword half could not locate, so the snippet and the location shown
together always come from the same half.

**Old pages are mapped by a sweep.** `blockMap IS NULL` means "still owed";
a page with nothing to locate stores an empty map. `backfill-search-block-map`
re-indexes up to 200 owed pages every ten minutes, which costs no embedding
call because the text is unchanged, and finds nothing once all are mapped.

## Consequences

`exo_search`, the built-in AI (through the same tool) and the palette name the
block of a keyword hit: a list point in a long list, the paragraph, or the file.
`exo_page_block_read` with that identifier reads exactly that place.

The map costs storage, measured on this deployment at the time of writing:
2,818 materialized pages hold 38,407 units, 1.55 MB of map as JSON text and
about 1.3 MB as stored (`pg_column_size` came to 81 % of the text on the
first 600 mapped rows), beside a `document_search_index` of 37 MB and a
`document_embedding` of 180 MB. The largest single map is 21 KB. Building one
takes at most 29 ms on the largest page, and a search costs about 50 ms instead
of 7 for twenty hits, most of it finding the fragment again in long texts; the
two CTEs that cut the headline are `MATERIALIZED`, because inlined they cut it
again for every unit of the map (850 ms).

A semantic hit still names its section only. Its passage is about two thousand
characters, several blocks long, and naming one block of it would be a guess.

The browser does not jump to the block yet: opening a page at a block from
outside the page is not something the page route does for any hit today. The
palette shows the section or the file in front of the snippet.
