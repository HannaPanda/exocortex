-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AiRuleMode" AS ENUM ('OFF', 'ALWAYS', 'ON_DEMAND');

-- CreateEnum
CREATE TYPE "AttachmentTextStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AiReasoningLevel" AS ENUM ('NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AiConversationRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');

-- AlterEnum
ALTER TYPE "SnapshotReason" ADD VALUE 'API_WRITE';

-- Note: `prisma migrate diff` also proposed dropping four indexes
-- (document_title_trgm_idx, document_property_value_json_gin,
-- document_search_index_searchVector_idx, document_search_index_title_trgm_idx)
-- and an `ALTER TABLE document_search_index ALTER COLUMN "searchVector" DROP
-- DEFAULT`. Those objects are raw-SQL search infrastructure (trigram indexes,
-- a GIN index over a GENERATED ALWAYS AS ... STORED tsvector column, and a
-- pgvector GIN index) created directly in earlier migrations and intentionally
-- not represented in schema.prisma (see the file header: "Anything requiring
-- raw SQL ... is modelled with Unsupported(...) and maintained by explicit SQL
-- in migrations/jobs"). `prisma migrate diff` cannot see them in the
-- datamodel and proposes dropping them; that would break search and database
-- views. Removed from this migration by hand -- see plan-01 brief step 3.

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "reasoningLevel" "AiReasoningLevel" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "toolIterations" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "attachment" ADD COLUMN     "extractedText" TEXT,
ADD COLUMN     "textExtractedAt" TIMESTAMP(3),
ADD COLUMN     "textExtractionError" TEXT,
ADD COLUMN     "textStatus" "AttachmentTextStatus" NOT NULL DEFAULT 'NOT_APPLICABLE';

-- AlterTable
ALTER TABLE "document" ADD COLUMN     "aiRuleMode" "AiRuleMode" NOT NULL DEFAULT 'OFF',
ADD COLUMN     "aiRulePriority" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "aiRuleTrigger" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "api_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openrouter',
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "contextWindowTokens" INTEGER NOT NULL,
    "maxOutputTokens" INTEGER,
    "supportsVision" BOOLEAN NOT NULL DEFAULT false,
    "supportsTools" BOOLEAN NOT NULL DEFAULT false,
    "reasoningLevels" "AiReasoningLevel"[] DEFAULT ARRAY[]::"AiReasoningLevel"[],
    "inputMicroUsdPerMTok" INTEGER NOT NULL,
    "outputMicroUsdPerMTok" INTEGER NOT NULL,
    "visionCompanionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "metadata" JSONB,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentId" TEXT,
    "modelId" TEXT,
    "reasoningLevel" "AiReasoningLevel" NOT NULL DEFAULT 'NONE',
    "visionCompanionSlug" TEXT,
    "estimatedTokens" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ai_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversation_message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiConversationRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolCalls" JSONB,
    "toolCallId" TEXT,
    "toolName" TEXT,
    "isSummary" BOOLEAN NOT NULL DEFAULT false,
    "supersededAt" TIMESTAMP(3),
    "runId" TEXT,
    "estimatedTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_conversation_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_token_tokenHash_key" ON "api_token"("tokenHash");

-- CreateIndex
CREATE INDEX "api_token_userId_idx" ON "api_token"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_slug_key" ON "ai_model"("slug");

-- CreateIndex
CREATE INDEX "ai_model_enabled_sortOrder_idx" ON "ai_model"("enabled", "sortOrder");

-- CreateIndex
CREATE INDEX "ai_conversation_workspaceId_createdById_lastMessageAt_idx" ON "ai_conversation"("workspaceId", "createdById", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ai_conversation_message_conversationId_createdAt_idx" ON "ai_conversation_message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_conversation_message_conversationId_supersededAt_idx" ON "ai_conversation_message"("conversationId", "supersededAt");

-- CreateIndex
CREATE INDEX "ai_run_conversationId_createdAt_idx" ON "ai_run"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "document_workspaceId_aiRuleMode_idx" ON "document"("workspaceId", "aiRuleMode");

-- AddForeignKey
ALTER TABLE "setting" ADD CONSTRAINT "setting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_model" ADD CONSTRAINT "ai_model_visionCompanionId_fkey" FOREIGN KEY ("visionCompanionId") REFERENCES "ai_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversation_message" ADD CONSTRAINT "ai_conversation_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

