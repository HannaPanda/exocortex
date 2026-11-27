-- Whether the page outline's scale opens its list when the pointer rests on
-- it rather than on a click (issue #283, third part).
--
-- Off for everybody: a click is the behaviour since #194, and a list that
-- opens on its own is a change a reader asks for rather than one they find.
-- Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "user" ADD COLUMN "outlineHoverExpand" BOOLEAN NOT NULL DEFAULT false;
