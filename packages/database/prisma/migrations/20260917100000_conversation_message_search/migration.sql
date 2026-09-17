-- Full-text search over conversation messages (issue #69).
--
-- The chat transcript was the one thing in eXocortex that could be written but
-- never found again. A generated column rather than a projection table with an
-- indexing job: a message arrives as plain text and never changes, so there is
-- nothing to materialize and nothing that could fall behind. `simple` is the
-- configuration `packages/database/src/search.ts` already uses, so a search
-- term behaves the same in both places.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "ai_conversation_message"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED;

CREATE INDEX "ai_conversation_message_searchVector_idx"
  ON "ai_conversation_message" USING GIN ("searchVector");

-- The listing across every workspace a person is a member of orders by
-- `lastMessageAt` and filters by creator alone; the existing index leads with
-- `workspaceId` and cannot serve that.
CREATE INDEX "ai_conversation_createdById_lastMessageAt_idx"
  ON "ai_conversation" ("createdById", "lastMessageAt" DESC);
