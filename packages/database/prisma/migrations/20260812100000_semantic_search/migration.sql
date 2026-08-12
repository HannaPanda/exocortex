-- Semantic search (issue #34, AP4).
--
-- The table and the `vector(1536)` column have existed since the initial
-- migration, reserved for exactly this. What was missing is everything that
-- makes it usable: a way to notice that a page's text has not changed, a
-- constraint that makes "one vector per page and model" an upsert instead of a
-- read-modify-write, and an index that turns a nearest-neighbour query into
-- something other than a sequential scan.

-- Hash of the text the vector was built from, so re-indexing an unchanged page
-- costs nothing. Nullable: rows written before this migration have no hash and
-- are simply re-embedded once.
ALTER TABLE "document_embedding" ADD COLUMN "textHash" TEXT;

-- One vector per document, block and model. `NULLS NOT DISTINCT` is the point:
-- the whole-document vector has `blockId IS NULL`, and under the default rule
-- two NULLs would count as different values, so every re-index would insert
-- another row instead of replacing one.
CREATE UNIQUE INDEX "document_embedding_documentId_blockId_model_key"
  ON "document_embedding" ("documentId", "blockId", "model") NULLS NOT DISTINCT;

-- HNSW for cosine distance (`<=>`), matching the operator the adapter orders by.
-- Cosine and not L2: embedding models return direction, not magnitude, and two
-- texts of very different length about the same subject must come out close.
--
-- `m` and `ef_construction` are pgvector's defaults. They are the right trade
-- for an index of this size (one row per page); raising them buys recall a
-- deployment with hundreds of thousands of pages would need and costs build
-- time this one would rather not pay.
CREATE INDEX "document_embedding_embedding_hnsw_idx"
  ON "document_embedding" USING hnsw ("embedding" vector_cosine_ops);
