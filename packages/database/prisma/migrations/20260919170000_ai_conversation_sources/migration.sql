-- Issue #75: a conversation may pin sources beside the page it is standing on.
CREATE TYPE "AiConversationSourceKind" AS ENUM ('PAGE', 'DATABASE_VIEW', 'SAVED_QUERY');
CREATE TYPE "AiConversationSourceMode" AS ENUM ('EMBED', 'REFERENCE');

CREATE TABLE "ai_conversation_source" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" "AiConversationSourceKind" NOT NULL,
    "mode" "AiConversationSourceMode" NOT NULL DEFAULT 'REFERENCE',
    "documentId" TEXT,
    "databaseViewId" TEXT,
    "savedQueryId" TEXT,
    "targetKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversation_source_pkey" PRIMARY KEY ("id")
);

-- Pinning the same thing twice is a no-op, not a second chip. The key is one
-- column because in PostgreSQL two NULLs are distinct, so a unique over the
-- three nullable target ids would never fire.
CREATE UNIQUE INDEX "ai_conversation_source_conversationId_targetKey_key" ON "ai_conversation_source"("conversationId", "targetKey");

-- The chip row, in the order the sources were pinned.
CREATE INDEX "ai_conversation_source_conversationId_createdAt_idx" ON "ai_conversation_source"("conversationId", "createdAt");
CREATE INDEX "ai_conversation_source_documentId_idx" ON "ai_conversation_source"("documentId");
CREATE INDEX "ai_conversation_source_databaseViewId_idx" ON "ai_conversation_source"("databaseViewId");
CREATE INDEX "ai_conversation_source_savedQueryId_idx" ON "ai_conversation_source"("savedQueryId");

-- Cascade on every target, not SetNull: a source is a reference, and a
-- reference to a deleted page, view or query is not a source any more. A row
-- left behind with three null ids could not be rendered and could not be
-- explained in the chip row either.
ALTER TABLE "ai_conversation_source" ADD CONSTRAINT "ai_conversation_source_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_conversation_source" ADD CONSTRAINT "ai_conversation_source_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_conversation_source" ADD CONSTRAINT "ai_conversation_source_databaseViewId_fkey" FOREIGN KEY ("databaseViewId") REFERENCES "database_view"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_conversation_source" ADD CONSTRAINT "ai_conversation_source_savedQueryId_fkey" FOREIGN KEY ("savedQueryId") REFERENCES "saved_query"("id") ON DELETE CASCADE ON UPDATE CASCADE;
