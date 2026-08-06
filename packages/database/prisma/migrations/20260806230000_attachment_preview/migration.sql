-- A downscaled copy of an image attachment, stored next to the original.
--
-- Derived data: the three columns are written and cleared together, and NULL
-- means "serve the original". `previewKey` is unique for the same reason
-- `storageKey` is: two rows must never claim the same object.
ALTER TABLE "attachment" ADD COLUMN "previewKey" TEXT;
ALTER TABLE "attachment" ADD COLUMN "previewMimeType" TEXT;
ALTER TABLE "attachment" ADD COLUMN "previewByteSize" INTEGER;

CREATE UNIQUE INDEX "attachment_previewKey_key" ON "attachment"("previewKey");
