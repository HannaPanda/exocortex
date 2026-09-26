-- Issue #139, ADR-067: what needs a person, in one place.
-- CreateEnum
CREATE TYPE "AttentionKind" AS ENUM ('DECISION', 'APPROVAL', 'REVIEW', 'BLOCKED', 'BUDGET', 'RUN_FAILED', 'CONFLICT', 'INFORMATION');

-- CreateEnum
CREATE TYPE "AttentionStatus" AS ENUM ('OPEN', 'RESOLVED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "AttentionNoteMode" AS ENUM ('NONE', 'OPTIONAL', 'REQUIRED');

-- AlterEnum
ALTER TYPE "WorkItemEventKind" ADD VALUE 'ATTENTION_RAISED';
ALTER TYPE "WorkItemEventKind" ADD VALUE 'ATTENTION_RESOLVED';

-- CreateTable
CREATE TABLE "attention_item" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "AttentionKind" NOT NULL,
    "status" "AttentionStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "urgency" "WorkItemPriority" NOT NULL DEFAULT 'NORMAL',
    "recipientId" TEXT,
    "raisedByKind" "WorkItemParticipantKind" NOT NULL,
    "raisedById" TEXT,
    "agentLabel" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "workItemId" TEXT,
    "aiRunId" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "noteMode" "AttentionNoteMode" NOT NULL DEFAULT 'OPTIONAL',
    "dedupeKey" TEXT,
    "settledAt" TIMESTAMP(3),
    "settledByKind" "WorkItemParticipantKind",
    "settledById" TEXT,
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attention_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attention_item_workspaceId_status_createdAt_idx" ON "attention_item"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "attention_item_recipientId_status_idx" ON "attention_item"("recipientId", "status");

-- CreateIndex
CREATE INDEX "attention_item_workItemId_status_idx" ON "attention_item"("workItemId", "status");

-- CreateIndex
CREATE INDEX "attention_item_aiRunId_idx" ON "attention_item"("aiRunId");

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_settledById_fkey" FOREIGN KEY ("settledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open item per waiting state. Settling frees the key, so the same
-- state entered again later raises a fresh item. Written by hand, because a
-- partial index is something the Prisma schema cannot say.
CREATE UNIQUE INDEX "attention_item_open_dedupe_unique" ON "attention_item" ("dedupeKey") WHERE "status" = 'OPEN' AND "dedupeKey" IS NOT NULL;

-- Open means unsettled, settled means somebody or something settled it.
ALTER TABLE "attention_item" ADD CONSTRAINT "attention_item_settled_shape_check" CHECK (
    ("status" = 'OPEN' AND "settledAt" IS NULL AND "settledByKind" IS NULL)
    OR ("status" <> 'OPEN' AND "settledAt" IS NOT NULL)
);
