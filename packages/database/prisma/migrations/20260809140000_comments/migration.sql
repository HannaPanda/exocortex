-- Comments on pages and on individual blocks (issue #18).
--
-- Purely additive: one new table, no existing column changes type and nothing
-- is dropped. `blockId` is a plain column, not a foreign key -- block
-- identifiers live inside the document, and a comment must survive the block it
-- names being deleted (`orphanedAt` records that, materialization sets it).

CREATE TABLE "comment" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "parentId" TEXT,
  "blockId" TEXT,
  "anchorText" TEXT,
  "orphanedAt" TIMESTAMP(3),
  "body" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "editedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,

  CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- The panel's own query: every thread of a page, oldest first.
CREATE INDEX "comment_documentId_createdAt_idx" ON "comment" ("documentId", "createdAt");

-- "Which blocks of this page carry a thread?" — the editor's markers, and the
-- orphan sweep that runs after every materialization.
CREATE INDEX "comment_documentId_blockId_idx" ON "comment" ("documentId", "blockId");

CREATE INDEX "comment_parentId_idx" ON "comment" ("parentId");
CREATE INDEX "comment_workspaceId_idx" ON "comment" ("workspaceId");
CREATE INDEX "comment_createdById_idx" ON "comment" ("createdById");

ALTER TABLE "comment"
  ADD CONSTRAINT "comment_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment"
  ADD CONSTRAINT "comment_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deleting a thread's root deletes its replies: a reply without the remark it
-- answers is not a comment, it is a fragment.
ALTER TABLE "comment"
  ADD CONSTRAINT "comment_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comment"
  ADD CONSTRAINT "comment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Whoever resolved a thread may leave; the thread stays resolved.
ALTER TABLE "comment"
  ADD CONSTRAINT "comment_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
