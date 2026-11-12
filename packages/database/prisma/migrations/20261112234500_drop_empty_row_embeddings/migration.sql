-- Issue #221: a database row with nothing on it but its title no longer gets
-- an embedding (`embeddingTargetsFor`), and the backfill no longer asks for
-- one. The vectors such rows were given before go, so the index says the same
-- about every row: full-text search still finds them by title.
DELETE FROM "document_embedding" AS embedding
USING "document" AS row, "document" AS parent, "document_search_index" AS index
WHERE embedding."documentId" = row."id"
  AND parent."id" = row."parentId"
  AND parent."type" = 'COLLECTION'
  AND index."documentId" = row."id"
  AND btrim(index."plainText") = '';
