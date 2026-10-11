-- Issue #161: the workflow runtime. Who switched a workflow on, the frozen
-- limits and chain depth of a run, leases and wake-up times on node attempts,
-- the projection of self-starting triggers, the run's event history, and the
-- workflow origin of an outbox row.

-- AlterTable
ALTER TABLE "workflow" ADD COLUMN "enabledById" TEXT;

-- AlterTable
ALTER TABLE "workflow_run" ADD COLUMN "limits" JSONB,
ADD COLUMN "deadlineAt" TIMESTAMP(3),
ADD COLUMN "chainDepth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "advancedAt" TIMESTAMP(3),
ADD COLUMN "eventCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "workflow_node_execution" ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "wakeAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN "workflowId" TEXT,
ADD COLUMN "workflowRunId" TEXT,
ADD COLUMN "workflowNodeExecutionId" TEXT;

-- CreateTable
CREATE TABLE "workflow_trigger" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeDocumentId" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run_event" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "nodeId" TEXT,
    "executionId" TEXT,
    "attempt" INTEGER,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_run_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_run_status_deadlineAt_idx" ON "workflow_run"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "workflow_node_execution_status_leaseExpiresAt_idx" ON "workflow_node_execution"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "workflow_node_execution_status_availableAt_idx" ON "workflow_node_execution"("status", "availableAt");

-- CreateIndex
CREATE INDEX "workflow_node_execution_status_wakeAt_idx" ON "workflow_node_execution"("status", "wakeAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_trigger_workflowId_nodeId_key" ON "workflow_trigger"("workflowId", "nodeId");

-- CreateIndex
CREATE INDEX "workflow_trigger_nodeType_nextRunAt_idx" ON "workflow_trigger"("nodeType", "nextRunAt");

-- CreateIndex
CREATE INDEX "workflow_trigger_workspaceId_nodeType_idx" ON "workflow_trigger"("workspaceId", "nodeType");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_event_runId_sequence_key" ON "workflow_run_event"("runId", "sequence");

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_enabledById_fkey" FOREIGN KEY ("enabledById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_trigger" ADD CONSTRAINT "workflow_trigger_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_trigger" ADD CONSTRAINT "workflow_trigger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run_event" ADD CONSTRAINT "workflow_run_event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
