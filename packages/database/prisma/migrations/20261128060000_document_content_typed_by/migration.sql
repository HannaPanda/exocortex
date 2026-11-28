-- Issue #235: who typed the change the collaboration server stored last, so a
-- version sampled while typing names its author. Nullable, filled from the
-- next store on; nothing to backfill.
ALTER TABLE "document_content" ADD COLUMN "yjsUpdatedById" TEXT;

ALTER TABLE "document_content" ADD CONSTRAINT "document_content_yjsUpdatedById_fkey" FOREIGN KEY ("yjsUpdatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
