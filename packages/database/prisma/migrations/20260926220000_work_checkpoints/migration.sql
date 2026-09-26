-- Issue #142, ADR-069: where a piece of work stands, recorded so a later run
-- can carry it on, with another model if need be.

-- CreateEnum
CREATE TYPE "WorkItemCheckpointTrigger" AS ENUM ('STEP', 'PAUSE', 'WAITING_FOR_HUMAN', 'EXTERNAL_WAIT', 'BUDGET', 'RUN_INTERRUPTED');

-- AlterEnum
ALTER TYPE "WorkItemEventKind" ADD VALUE 'CHECKPOINT_RECORDED';

-- CreateTable
CREATE TABLE "work_item_checkpoint" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "aiRunId" TEXT,
    "trigger" "WorkItemCheckpointTrigger" NOT NULL,
    "authorKind" "WorkItemParticipantKind" NOT NULL,
    "authorId" TEXT,
    "agentLabel" TEXT,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT NOT NULL DEFAULT '',
    "state" JSONB NOT NULL DEFAULT '{}',
    "refs" JSONB NOT NULL DEFAULT '[]',
    "pendingAttentionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "interruptionCode" TEXT,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "budgetMicroUsd" INTEGER,
    "provider" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_item_checkpoint_workItemId_createdAt_idx" ON "work_item_checkpoint"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "work_item_checkpoint_aiRunId_idx" ON "work_item_checkpoint"("aiRunId");

-- CreateIndex
CREATE INDEX "work_item_checkpoint_authorId_idx" ON "work_item_checkpoint"("authorId");

-- AddForeignKey
ALTER TABLE "work_item_checkpoint" ADD CONSTRAINT "work_item_checkpoint_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_checkpoint" ADD CONSTRAINT "work_item_checkpoint_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_checkpoint" ADD CONSTRAINT "work_item_checkpoint_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One interruption checkpoint per run, so the sweep that writes them can run
-- twice without writing twice. Hand-written: Prisma cannot say a partial index.
CREATE UNIQUE INDEX "work_item_checkpoint_interrupted_run_key" ON "work_item_checkpoint"("aiRunId") WHERE "trigger" = 'RUN_INTERRUPTED';
