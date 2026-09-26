-- Issue #141, ADR-070: changes an agent proposes instead of writing, decided
-- one by one by a person.

-- CreateEnum
CREATE TYPE "ChangesetStatus" AS ENUM ('DRAFT', 'READY', 'PARTIALLY_APPLIED', 'APPLIED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "ChangesetChangeKind" AS ENUM ('BLOCK', 'SECTION', 'PATCH', 'PAGE', 'CREATE');

-- CreateEnum
CREATE TYPE "ChangesetChangeStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'STALE');

-- CreateTable
CREATE TABLE "changeset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "status" "ChangesetStatus" NOT NULL DEFAULT 'DRAFT',
    "proposerKind" "WorkItemParticipantKind" NOT NULL,
    "proposedById" TEXT,
    "agentLabel" TEXT,
    "workItemId" TEXT,
    "aiRunId" TEXT,
    "revisesId" TEXT,
    "contentHash" TEXT,
    "attentionItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "changeset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changeset_change" (
    "id" TEXT NOT NULL,
    "changesetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ChangesetChangeKind" NOT NULL,
    "documentId" TEXT,
    "parentId" TEXT,
    "title" TEXT,
    "request" JSONB NOT NULL,
    "message" TEXT,
    "baseRevision" TIMESTAMP(3),
    "expectedRevision" TIMESTAMP(3),
    "diff" JSONB NOT NULL,
    "status" "ChangesetChangeStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByKind" "WorkItemParticipantKind",
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "errorCode" TEXT,
    "snapshotId" TEXT,
    "createdDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changeset_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "changeset_workspaceId_closedAt_updatedAt_idx" ON "changeset"("workspaceId", "closedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "changeset_workItemId_idx" ON "changeset"("workItemId");

-- CreateIndex
CREATE INDEX "changeset_aiRunId_idx" ON "changeset"("aiRunId");

-- CreateIndex
CREATE INDEX "changeset_proposedById_idx" ON "changeset"("proposedById");

-- CreateIndex
CREATE INDEX "changeset_change_documentId_idx" ON "changeset_change"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "changeset_change_changesetId_position_key" ON "changeset_change"("changesetId", "position");

-- AddForeignKey
ALTER TABLE "changeset" ADD CONSTRAINT "changeset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset" ADD CONSTRAINT "changeset_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset" ADD CONSTRAINT "changeset_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset" ADD CONSTRAINT "changeset_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset" ADD CONSTRAINT "changeset_revisesId_fkey" FOREIGN KEY ("revisesId") REFERENCES "changeset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset_change" ADD CONSTRAINT "changeset_change_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "changeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changeset_change" ADD CONSTRAINT "changeset_change_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

