-- Where a pinned page outline sits, and how much of the text it lets through
-- when it lies over it (issue #283).
--
-- Personal preferences on the account, like the interface language and the
-- chat's scrolling. `COLUMN` is the behaviour since #267 (the list takes a
-- column of its own and the text moves aside) and the default for everybody
-- who never chose; `OVERLAY` lays the list over the text. The transparency is
-- only read for an overlay. Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "OutlinePinnedMode" AS ENUM ('COLUMN', 'OVERLAY');

CREATE TYPE "OutlineTransparency" AS ENUM ('NONE', 'LIGHT', 'STRONG');

ALTER TABLE "user"
  ADD COLUMN "outlinePinned" "OutlinePinnedMode" NOT NULL DEFAULT 'COLUMN',
  ADD COLUMN "outlineTransparency" "OutlineTransparency" NOT NULL DEFAULT 'NONE';
