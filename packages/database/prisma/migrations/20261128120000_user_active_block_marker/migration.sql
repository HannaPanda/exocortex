-- Whether the editor marks the block the caret is in with a short line in the
-- left margin while it has the focus (issue #238).
--
-- On for everybody: the mark is a hairline in the gutter that moves nothing,
-- and a caret that is hard to find on a long page is the problem it answers.
-- Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "user" ADD COLUMN "activeBlockMarker" BOOLEAN NOT NULL DEFAULT true;
