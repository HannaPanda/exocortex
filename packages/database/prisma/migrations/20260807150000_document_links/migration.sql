-- Reference index: which page mentions which other page (issue #19).
--
-- Derived data, rebuilt by materialization in the same pass that derives
-- Markdown, plain text and the search projection (ADR-007). `targetDocumentId`
-- is nullable because a reference addresses a title, not an identity (#14):
-- it stays null until a page with that title exists, and the
-- `resolve-document-links` maintenance task re-points it when one is created,
-- renamed or moved.
--
-- Additive throughout: no existing table loses a column, and `linksIndexedAt`
-- is nullable so every existing row is picked up by the backfill sweep.

CREATE TYPE "DocumentLinkKind" AS ENUM ('PAGE_LINK', 'MENTION', 'WIKI_MARK');

CREATE TABLE "document_link" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sourceDocumentId" TEXT NOT NULL,
  "targetDocumentId" TEXT,
  "targetTitle" TEXT NOT NULL,
  "targetTitleKey" TEXT NOT NULL,
  "kind" "DocumentLinkKind" NOT NULL,
  "blockId" TEXT,
  "context" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "document_link_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_link_sourceDocumentId_kind_targetTitleKey_blockId_key"
  ON "document_link" ("sourceDocumentId", "kind", "targetTitleKey", "blockId");

-- "Who links to this page?" — the query behind the Verweise tab.
CREATE INDEX "document_link_targetDocumentId_idx" ON "document_link" ("targetDocumentId");

-- Resolution after a page is created or renamed.
CREATE INDEX "document_link_workspaceId_targetTitleKey_idx"
  ON "document_link" ("workspaceId", "targetTitleKey");

CREATE INDEX "document_link_sourceDocumentId_position_idx"
  ON "document_link" ("sourceDocumentId", "position");

ALTER TABLE "document_link"
  ADD CONSTRAINT "document_link_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_link"
  ADD CONSTRAINT "document_link_sourceDocumentId_fkey"
  FOREIGN KEY ("sourceDocumentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting the target does not delete the reference: it becomes unresolved,
-- which is what it now is.
ALTER TABLE "document_link"
  ADD CONSTRAINT "document_link_targetDocumentId_fkey"
  FOREIGN KEY ("targetDocumentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Marks a content row whose references have been extracted. NULL is "never
-- seen", which is what the backfill sweep selects on.
ALTER TABLE "document_content" ADD COLUMN "linksIndexedAt" TIMESTAMP(3);

CREATE INDEX "document_content_linksIndexedAt_idx" ON "document_content" ("linksIndexedAt");

-- Normalized-title lookup on the document side, so resolving a reference does
-- not scan every page of a workspace. The same expression as
-- `documentLinkTitleKey` in @exocortex/editor and as the existing
-- `GET /documents/resolve` query; all three must stay in step.
CREATE INDEX "document_workspaceId_title_key_idx"
  ON "document" ("workspaceId", (lower(btrim(regexp_replace("title", '\s+', ' ', 'g')))));
