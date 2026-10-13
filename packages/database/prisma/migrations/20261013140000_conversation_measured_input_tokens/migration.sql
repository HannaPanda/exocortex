-- Issue #193: the context meter reads what the provider reported as the
-- newest turn's input, not a running sum of message estimates that never
-- saw the system prompt, the tool schemas or a single tool result.
-- NULL means no turn has been measured since the transcript last changed shape
-- (a new conversation, `/clear`, a compaction).

-- AlterTable
ALTER TABLE "ai_conversation" ADD COLUMN     "measuredInputTokens" INTEGER;
