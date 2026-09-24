# ADR-061: context is compiled from passages, not pages

- Status: accepted
- Date: 2026-09-24

## Context

An agent with a knowledge question ("what do we know about the backup") had
two tools and neither fitted. `exo_search` names pages and shows one snippet
each; `exo_page_read` loads one named page, or since ADR-056 its map. The
answer the agent wanted was four paragraphs out of three pages, and getting
there meant a search, several reads, and cutting the result down itself, with
every intermediate step paid for in its context.

Most of what an answer needs was already there. ADR-034 stores long pages as
passages with their text beside the vector, ADR-058 gives each passage the
heading above it, ADR-044 confines a credential to a branch, and
`memory/recall` shows that a search across every readable workspace can be
ranked as one list. What was missing sat between search and prompt (issue
#110): something that sees passages before the search folds them to one per
page, fuses the two halves at that level, and packs the result into a budget.

## Decision

**A port of its own, beside the page search.** `PassageSearchPort` in
`packages/database/src/passage-search.ts` answers with passages;
`SearchAdapter.search` still answers with pages and is unchanged. The search
box wants one line per page and ADR-034's fold is right for it. Putting a flag
on the page search would have made every caller of it carry a question only
one of them asks.

**The same search, cut finer, not a second algorithm.** The keyword half runs
the page search's own predicate and rank (`keywordMatchSql`, shared with
`PostgresSearchAdapter`), then cuts each page with `chunkPlainText`, the cut
the embeddings were built from, and orders a page's passages by how many of
the words they carry. The semantic half reads the nearest passage rows
without the `DISTINCT ON` fold; a whole-document row counts only for a page
too short to have been cut, because on a long page it is the average of its
passages and those compete in its place. Both lists are fused by reciprocal
rank, the same method and constant as for pages, keyed by page and passage
ordinal. The ordinal is an identity for one request only: the stored
`chunk:NNNN` ids move when a page does, so nothing outside the process is ever
told about them.

**A floor under the vectors.** Every question has nearest neighbours, so the
semantic list is cut at a cosine similarity of 0.35, measured on this
deployment (relevant passages 0.36 to 0.64, the first unrelated ones at 0.31).
Without it the packer fills whatever budget it is given.

**Exact keyword hits are protected.** The best passage of each of the first
three keyword pages that carries every word of the question is packed ahead of
the fused ranking. A file name or a term asked for verbatim must not lose to a
vector that preferred something else; the issue named that case first.

**Packing is greedy, measured on the rendered text, and pure.**
`packContext` takes the best remaining candidate, halves the score of every
further passage from a page that already contributed, and admits it when the
rendered answer stays inside `maxChars` and the page's ceiling (a third of the
budget by default). A candidate that does not fit is cut at a word boundary
when at least 300 characters survive and dropped otherwise. A paragraph that
is word for word already in the answer is not paid for twice, and the overlap
`chunkPlainText` repeats at the start of the next passage is removed when both
neighbours are chosen. No database, no model, no clock: identical candidates
pack to the identical answer, which is what makes the evaluation set in
`context-packing.test.ts` an evaluation rather than a snapshot.

**Verbatim, never generated.** The compiler selects; it does not summarise.
There is nothing in an answer that is not on a page the caller can open, a
deployment without a generative model has the whole feature, and the caller
decides what the evidence means.

**Authority is the search's, applied before ranking.** Each workspace goes
through `requireScopedRole`; a confined credential's page set travels into
both SQL statements as a filter, rather than being applied to the result,
because a fused score is a position in a list and a position computed against
invisible pages says they exist. Paths are resolved by the search's own
`resolvePaths`, so the section above a shared branch is not named. A named
workspace the caller cannot read is refused like a search would refuse it;
unnamed, the compiler looks in every membership except the memory area,
whose session notes are what `memory/recall` is for.

**Only the page's own text, never its attachments.** The search projection
carries the text extracted from a page's attachments behind the page (issue
#101), with no stored boundary. That text is foreign in the sense of ADR-030:
`exo_attachment_read_text` hands it over behind the fence, and an unfenced
tool that returned it would be the way around the fence. So the keyword half
cuts `document_content.plainText` rather than the projection, and a passage
vector is handed over only when its text stands verbatim in that page text
(`strpos`), which also drops a passage the page has lost since it was
embedded. A page found only through its PDF contributes nothing unless its
title matched. `exo_search` still finds it; reading the PDF is a deliberate,
fenced second step.

**A GET under `/api/context`.** It changes nothing, and
`requiredScopeForRequest` keys on the method: a read-only token may compile
context. It is not under a workspace because the answer can span several.

## Consequences

`exo_context_compile` (domain `core`, both agent surfaces) is the first call
for a knowledge question, and `exo_search` and `exo_page_read` keep their jobs:
finding pages and reading a named one.

A keyword-only passage is located when a passage vector with the same ordinal
and the same text stores a heading, which covers every long page that has been
embedded. The offset-to-block table ADR-058 expected this issue to build was
not needed for that, and the page search's keyword hits stay unlocated.

Very long pages are cut at request time into up to 256 passages, beyond the
64 the embeddings stop at, so text past 128,000 characters is reachable by
keyword even though it has no vector. The plain text read per page is capped
at 600,000 characters.

The answer logs counts only (workspaces, stages, candidates, sources,
passages, characters, truncation, duration), never the question or a passage.

An optional reranking stage (#108) would sit between fusion and packing. The
compiler does not need one, and the protection of exact hits is applied after
fusion, so a reranker could not remove them either.
