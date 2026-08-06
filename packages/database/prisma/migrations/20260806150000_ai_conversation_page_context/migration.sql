-- Whether a conversation discloses its open page to the model.
--
-- Default true: the page context shipped enabled, and an existing conversation
-- that never made a choice should keep behaving the way it did yesterday.
-- `documentId` stays the record of where the user is standing; this column only
-- decides whether that is disclosed.
ALTER TABLE "ai_conversation"
  ADD COLUMN "pageContextEnabled" BOOLEAN NOT NULL DEFAULT true;
