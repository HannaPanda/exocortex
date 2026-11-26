-- What an `ai_run` row records (issue #252, ADR-090).
--
-- A page cover is a paid call like a run's turn, and the usage report reads
-- `ai_run` and nothing else. So a drawn picture is recorded as a row of its
-- own kind rather than in a second table the report would have to union in.
-- Purely additive: every existing row is a chat run, which is the default.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

CREATE TYPE "AiRunKind" AS ENUM ('CHAT', 'IMAGE');

ALTER TABLE "ai_run" ADD COLUMN "kind" "AiRunKind" NOT NULL DEFAULT 'CHAT';
