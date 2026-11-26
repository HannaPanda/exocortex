-- How the AI chat's transcript moves while an answer arrives (issue #282).
--
-- A personal preference on the account, like the interface language: either
-- the transcript follows the newest line (the behaviour since #242, and the
-- default for everybody who never chose), or it brings the question to the
-- top once and then leaves the view alone. Purely additive.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "ChatScrollMode" AS ENUM ('FOLLOW', 'ANSWER_START');

ALTER TABLE "user" ADD COLUMN "chatScroll" "ChatScrollMode" NOT NULL DEFAULT 'FOLLOW';
