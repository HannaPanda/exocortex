-- Page body width (presentation only, no canonical state).
CREATE TYPE "DocumentLayout" AS ENUM ('NARROW', 'WIDE', 'FULL');

ALTER TABLE "document"
  ADD COLUMN "layout" "DocumentLayout" NOT NULL DEFAULT 'NARROW';

-- Databases already rendered across the whole width before this column
-- existed; leaving them on the NARROW default would visibly shrink every
-- existing table view.
UPDATE "document" SET "layout" = 'FULL' WHERE "type" = 'COLLECTION';
