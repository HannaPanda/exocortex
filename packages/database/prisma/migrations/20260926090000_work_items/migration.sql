-- Issue #138, ADR-066: delegated work as its own unit, with a history and the runs behind it.
-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('QUEUED', 'WORKING', 'BLOCKED', 'WAITING_FOR_HUMAN', 'REVIEW', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkItemPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "WorkItemParticipantKind" AS ENUM ('HUMAN', 'AGENT', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "WorkItemEventKind" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ASSIGNED', 'RUN_STARTED', 'RESULT_RECORDED', 'NOTE');

-- CreateEnum
CREATE TYPE "WorkItemRefRole" AS ENUM ('CONTEXT', 'RESULT');

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN     "workItemId" TEXT;

-- CreateTable
CREATE TABLE "work_item" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" "WorkItemStatus" NOT NULL DEFAULT 'QUEUED',
    "statusReason" TEXT,
    "priority" "WorkItemPriority" NOT NULL DEFAULT 'NORMAL',
    "requesterKind" "WorkItemParticipantKind" NOT NULL,
    "requesterId" TEXT,
    "assigneeKind" "WorkItemParticipantKind",
    "assigneeId" TEXT,
    "acceptanceCriteria" JSONB NOT NULL DEFAULT '[]',
    "result" TEXT,
    "budgetMicroUsd" INTEGER,
    "dueAt" TIMESTAMP(3),
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "work_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_event" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "kind" "WorkItemEventKind" NOT NULL,
    "actorKind" "WorkItemParticipantKind" NOT NULL,
    "actorId" TEXT,
    "agentLabel" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_ref" (
    "workItemId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "role" "WorkItemRefRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_ref_pkey" PRIMARY KEY ("workItemId","role","documentId")
);

-- CreateIndex
CREATE INDEX "work_item_workspaceId_closedAt_updatedAt_idx" ON "work_item"("workspaceId", "closedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "work_item_assigneeId_closedAt_idx" ON "work_item"("assigneeId", "closedAt");

-- CreateIndex
CREATE INDEX "work_item_requesterId_idx" ON "work_item"("requesterId");

-- CreateIndex
CREATE INDEX "work_item_parentId_idx" ON "work_item"("parentId");

-- CreateIndex
CREATE INDEX "work_item_event_workItemId_createdAt_idx" ON "work_item_event"("workItemId", "createdAt");

-- CreateIndex
CREATE INDEX "work_item_event_actorId_idx" ON "work_item_event"("actorId");

-- CreateIndex
CREATE INDEX "work_item_ref_documentId_idx" ON "work_item_ref"("documentId");

-- CreateIndex
CREATE INDEX "ai_run_workItemId_createdAt_idx" ON "ai_run"("workItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_event" ADD CONSTRAINT "work_item_event_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_event" ADD CONSTRAINT "work_item_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_ref" ADD CONSTRAINT "work_item_ref_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_ref" ADD CONSTRAINT "work_item_ref_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "document"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The built-in AI has no account, so an item assigned to it carries no id;
-- and an item nobody has taken carries neither kind nor id. A HUMAN or AGENT
-- assignee may lose its id to ON DELETE SET NULL, which is why the id is not
-- required the other way round.
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_assignee_shape_check" CHECK (
    ("assigneeKind" IS NULL AND "assigneeId" IS NULL)
    OR ("assigneeKind" = 'ASSISTANT' AND "assigneeId" IS NULL)
    OR ("assigneeKind" IN ('HUMAN', 'AGENT'))
);

-- A budget is an amount, not a debt.
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_budget_check" CHECK ("budgetMicroUsd" IS NULL OR "budgetMicroUsd" >= 0);
