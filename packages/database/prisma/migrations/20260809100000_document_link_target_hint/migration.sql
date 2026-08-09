-- The reference index learns the identity a reference carries (issue #14).
--
-- Until now a reference addressed its target by title alone, so renaming a
-- page orphaned every row pointing at it until the resolution sweep found the
-- new title — and if two pages swapped names, silently pointed them at each
-- other. `pageLink.documentId` and `mention.id` now travel with the reference,
-- and `targetHintId` is where the extractor puts them.
--
-- Deliberately *not* a foreign key: a hint must survive its target being
-- deleted (that is the difference between "the identity is gone" and "there
-- never was one"), and it may name a document in another workspace after a
-- page is moved. `targetDocumentId` stays the resolved pointer and keeps its
-- `SET NULL` foreign key.
--
-- Additive: every existing row gets NULL, which means "no identity recorded",
-- which is exactly what those rows are. They keep resolving by title until the
-- next materialization of their source page rewrites them.

ALTER TABLE "document_link" ADD COLUMN "targetHintId" TEXT;

-- Resolution by identity, which is what a rename no longer has to touch.
CREATE INDEX "document_link_targetHintId_idx" ON "document_link" ("targetHintId");
