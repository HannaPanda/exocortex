-- Where each page of an extracted PDF begins (issue #133, ADR-101). Empty for
-- every existing row: those learn their pages on their next extraction.
ALTER TABLE "attachment" ADD COLUMN "textPageStarts" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
