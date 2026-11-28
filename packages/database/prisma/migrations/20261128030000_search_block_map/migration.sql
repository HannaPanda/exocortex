-- Issue #280: which block every stretch of the search projection came from,
-- so a keyword hit can name its block and section. NULL means "still owed";
-- the backfill-search-block-map sweep re-indexes those pages in batches.
ALTER TABLE "document_search_index" ADD COLUMN "blockMap" JSONB;
