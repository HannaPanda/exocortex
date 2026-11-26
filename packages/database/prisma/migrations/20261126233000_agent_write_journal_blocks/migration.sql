-- Which blocks an agent's write changed (issue #248).
--
-- One AI run can now be taken back from the chat block by block. To do that
-- without overwriting what a person wrote afterwards, every journalled write
-- keeps the top-level blocks it changed together with a fingerprint of how it
-- left each one; a block whose fingerprint no longer matches the page is named
-- and left alone. Fingerprints only, never content (ADR-022). Purely additive:
-- older rows keep NULL and their pages are reported as not recorded.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "agent_write_journal" ADD COLUMN "writtenBlocks" JSONB;
