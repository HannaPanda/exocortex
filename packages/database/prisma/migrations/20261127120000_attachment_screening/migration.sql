-- Screening an uploaded file for instructions addressed to an AI (ADR-096).
--
-- A model is asked once, when a file's text is extracted or a picture is
-- described, whether that text addresses an AI. The answer lives here, on the
-- file: `screening` is NULL until somebody asked, CLEAN when nothing was
-- found, FLAGGED for a finding and FAILED when the question could not be
-- answered. Only CLEAN lets the uploader's own AI runs read the file and keep
-- writing; everything else stays foreign content as before (ADR-030).
--
-- `fetchedFromUrl` marks a file the server fetched from the web for its
-- uploader. Its text is the web's, whoever asked for it, so it never counts
-- as the person's own. Rows from before this column are left at false.
--
-- Purely additive. Written by hand, like every migration here.

CREATE TYPE "AttachmentScreening" AS ENUM ('CLEAN', 'FLAGGED', 'FAILED');

ALTER TABLE "attachment" ADD COLUMN "screening" "AttachmentScreening";
ALTER TABLE "attachment" ADD COLUMN "screenedAt" TIMESTAMP(3);
ALTER TABLE "attachment" ADD COLUMN "screenModel" TEXT;
ALTER TABLE "attachment" ADD COLUMN "screenScore" DOUBLE PRECISION;
ALTER TABLE "attachment" ADD COLUMN "fetchedFromUrl" BOOLEAN NOT NULL DEFAULT false;
