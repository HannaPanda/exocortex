-- Files on chat messages (issue #223).
--
-- A picture pasted into the AI chat is an ordinary attachment row, but its
-- owner is the conversation rather than a page: only the conversation's
-- creator reads it, and deleting the conversation deletes the row (the
-- objects are removed by the service that deletes it). `conversationMessageId`
-- is the message that carried it, null between upload and send. The three
-- `image*` columns keep what a vision model saw, so a conversation pays for a
-- picture once rather than on every turn.
--
-- Purely additive: every existing row keeps NULL in all five columns.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "attachment" ADD COLUMN "conversationId" TEXT;
ALTER TABLE "attachment" ADD COLUMN "conversationMessageId" TEXT;
ALTER TABLE "attachment" ADD COLUMN "imageDescription" TEXT;
ALTER TABLE "attachment" ADD COLUMN "imageDescribedAt" TIMESTAMP(3);
ALTER TABLE "attachment" ADD COLUMN "imageDescriptionModel" TEXT;

CREATE INDEX "attachment_conversationId_idx" ON "attachment"("conversationId");
CREATE INDEX "attachment_conversationMessageId_idx" ON "attachment"("conversationMessageId");

ALTER TABLE "attachment" ADD CONSTRAINT "attachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_conversationMessageId_fkey" FOREIGN KEY ("conversationMessageId") REFERENCES "ai_conversation_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A chat file hangs on no page. Taking a page's access (ADR-044) and the
-- conversation's privacy at once would leave nobody able to say who may read it.
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_chat_not_on_page" CHECK ("conversationId" IS NULL OR "documentId" IS NULL);
