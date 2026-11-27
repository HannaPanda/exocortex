-- What an agent's write did to a page beyond its blocks (issue #248).
--
-- An AI run can now also take back a rename, a move and a page it created,
-- with the same rule as for blocks: only while the page still stands as the
-- run left it. That needs two more facts per journalled write, neither of
-- them content (ADR-022): `structure` says what a rename or a move changed
-- (the title before and after, the parent and position before and after),
-- and `pageAfter` is one fingerprint of the page's whole content as the write
-- left it, so a page the run created can tell whether anybody wrote in it
-- since. Purely additive: older rows keep NULL and are named, not undone.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "agent_write_journal" ADD COLUMN "structure" JSONB;
ALTER TABLE "agent_write_journal" ADD COLUMN "pageAfter" TEXT;
