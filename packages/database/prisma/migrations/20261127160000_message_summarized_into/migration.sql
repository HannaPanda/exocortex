-- The compaction summary that took a message in, so its files stay in the
-- context after the summary (issue #223).
ALTER TABLE "ai_conversation_message" ADD COLUMN "summarizedIntoId" TEXT;
CREATE INDEX "ai_conversation_message_summarizedIntoId_idx" ON "ai_conversation_message"("summarizedIntoId");
