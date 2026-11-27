-- Whether a pinned outline laid over the text steps aside for the line being
-- written on (issue #283, second part).
--
-- On for everybody: it only acts while `outlinePinned` is `OVERLAY`, which
-- nobody had before the first part of the issue, so the default changes
-- nothing for a page anybody has seen, and a hidden caret is the one cost
-- the overlay should not have. Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "user" ADD COLUMN "outlineDodge" BOOLEAN NOT NULL DEFAULT true;
