-- A passage vector remembers the heading it sits under (issue #118).
--
-- `headingPath` is `NULL` on a row nobody has worked the heading out for, and
-- an empty array on a passage that genuinely sits under none. The two have to
-- be distinguishable: the first is what `backfill-passage-anchors` looks for,
-- and without the distinction that sweep would revisit every headingless page
-- forever.
ALTER TABLE "document_embedding"
  ADD COLUMN "headingBlockId" TEXT,
  ADD COLUMN "headingPath" JSONB;

-- Only the sweep reads this, and only for the passages that are still owed an
-- anchor, so the index covers exactly those rows and shrinks to nothing once
-- the backfill is done.
CREATE INDEX "document_embedding_anchor_pending_idx"
  ON "document_embedding" ("documentId")
  WHERE "blockId" IS NOT NULL AND "headingPath" IS NULL;
