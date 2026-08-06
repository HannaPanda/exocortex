-- Page cover image (presentation only, no canonical state).
--
-- The image itself is an ordinary attachment, so upload, magic-byte check and
-- access control stay in one place. Hard-deleting that attachment clears the
-- reference rather than leaving a page pointing at nothing.
ALTER TABLE "document"
  ADD COLUMN "coverAttachmentId" TEXT,
  ADD COLUMN "coverPosition" DOUBLE PRECISION NOT NULL DEFAULT 50;

CREATE INDEX "document_coverAttachmentId_idx" ON "document"("coverAttachmentId");

ALTER TABLE "document"
  ADD CONSTRAINT "document_coverAttachmentId_fkey"
  FOREIGN KEY ("coverAttachmentId") REFERENCES "attachment"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Marks a file that was uploaded to be a cover and nothing else. Only those are
-- ever collected once they stop being one.
ALTER TABLE "attachment"
  ADD COLUMN "isCover" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "attachment_isCover_idx" ON "attachment"("isCover");
