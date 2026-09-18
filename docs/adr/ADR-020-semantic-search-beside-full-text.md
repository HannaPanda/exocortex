# ADR-020: semantic search sits beside full-text, never instead of it

- Status: accepted
- Date: 2026-08-12

## Context

Issue #34 (AP4) is the last of the memory work: recall that answers "I only know
what it was about". Full-text cannot do that. A `tsvector` matches words, so a
note filed under `Termine` is invisible to a question about `Verabredungen`, and
that is exactly the question an agent asks when it starts a session in a
directory it has not seen for a month.

The schema has been ready since the first migration: the `vector` extension is
installed and `DocumentEmbedding` has a `vector(1536)` column. What was missing
was everything around it.

Three things had to be decided.

**Where do the vectors come from?** A local embedding container was the obvious
guess, and it was wrong: OpenRouter serves an OpenAI-shaped `/embeddings`
endpoint, and the deployment already has an OpenRouter key for everything else.
`openai/text-embedding-3-small` returns exactly 1536 dimensions and costs about
two cents per million tokens. No second service, no second key, no model
weights on a machine that shares its memory with a dozen containers.

**Does the vector list replace the keyword list or join it?** Replacing it would
lose the case full-text is best at: somebody who does remember the word, or is
searching for an identifier, a name, a slug. Vector similarity is famously
willing to return something related to everything.

**What happens when the embedding call fails?** It is a paid network call in the
path of the search box, and the search box is the most-used thing in the
application.

## Decision

**Both halves run and their ranks are fused.** `HybridSearchAdapter` wraps
`PostgresSearchAdapter` rather than replacing it. The full-text list and the
nearest-neighbour list are merged by reciprocal rank fusion
(`score = weight / (60 + position)`), which compares _positions_ rather than
scores: `ts_rank_cd` and cosine similarity are different units, and normalising
one onto the other would invent a scale neither has. `search.semanticWeightPercent`
says how much the semantic list counts; at 0 the answer is the full-text answer.

**Degradation is one-directional.** A missing key, an exhausted account, a
timeout or a model that returns the wrong number of dimensions is logged and the
search answers from full-text alone. The reverse never happens: a page found
only by meaning is a real hit and is merged in. The same rule holds while
indexing — the full-text projection is written first, and a page that could not
be embedded is still findable.

**The vector is written by the indexing path, not by a queue of its own.**
Embedding is part of keeping the search projection in sync, so it happens inside
`SearchAdapter.index`, on the `search-indexing` job that already runs after
every materialization. A `textHash` column makes a re-index of unchanged text
free, which matters because editing a page re-indexes it every few seconds.

**`packages/database` does not learn about `packages/ai`.** The adapter declares
an `EmbeddingClient` port and the composition roots pass a bridge over
`EmbeddingProvider`. The dependency graph (`scripts/dependency-graph.mjs`) keeps
infrastructure packages independent of each other, and semantic search is not a
reason to weaken it.

**Off by default, with a backfill to catch up.** Switching
`search.semanticEnabled` on turns every indexed page into a paid call, so a
deployment opts in. `backfill-embeddings` then works through the pages that
already exist, newest first, twenty-five at a time, every two minutes; it is a
no-op once they all have vectors, and a no-op while the setting is off.

## Consequences

- A page is embedded as `title + plainText`, truncated to 24k characters. Since
  issue #36 a long page carries passage vectors as well, beside that one and
  never instead of it; the `blockId` column is what holds them
  ([ADR-034](ADR-034-passages-beside-the-page-vector.md)).
- Switching the model in `search.embeddingModelSlug` invalidates nothing by
  hand: the vector query filters on the model, so the old rows stop being read,
  the backfill writes new ones, and the next write of a page drops the stale
  row. Two models are never mixed in one ranking.
- A model that does not return 1536 dimensions is refused rather than stored.
  The column is fixed-width and an HNSW index needs it to be.
- Every search with the feature on costs one embedding call for the query. That
  is the price of the second half, and it is why the setting exists.
