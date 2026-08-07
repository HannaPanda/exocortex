-- Lets a human correct the extracted text of an attachment, and records that
-- the correction happened (issue #2).
--
-- `correctedText` is a column of its own rather than an overwrite of
-- `extractedText`: a later re-extraction (forced or not) must never silently
-- discard a correction, and the two staying separate is what lets the UI show
-- that a correction exists at all. `textTruncated` records that the last
-- successful extraction was cut off at `ATTACHMENT_TEXT_MAX_CHARS`, which used
-- to happen silently.
--
-- Additive and nullable/defaulted throughout, so this is safe on the running
-- database and an older worker process keeps working.
ALTER TABLE "attachment"
  ADD COLUMN "textTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "correctedText" TEXT,
  ADD COLUMN "textCorrectedAt" TIMESTAMP(3),
  ADD COLUMN "textCorrectedById" TEXT;

ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_textCorrectedById_fkey"
  FOREIGN KEY ("textCorrectedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
