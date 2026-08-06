-- Engine-reported facts about an extracted PDF: the document's own title,
-- author and dates plus page, table and picture counts. Shaped by
-- `pdfMetadataSchema` in @exocortex/contracts.
--
-- Written by hand. `prisma migrate dev` also wanted to drop the four raw-SQL
-- indexes and the generated `document_search_index.searchVector` expression,
-- none of which the Prisma schema can express, so its generated diff would
-- have destroyed the search index.
ALTER TABLE "attachment" ADD COLUMN "textMetadata" JSONB;
