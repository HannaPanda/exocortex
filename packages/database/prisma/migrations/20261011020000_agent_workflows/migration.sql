-- Issue #160, ADR-075: agent workflows. A workflow with its mutable draft,
-- the immutable versions published from it, the runs of a version and the
-- attempts of every node in a run.

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "WorkflowRunOrigin" AS ENUM ('MANUAL', 'SCHEDULE', 'EVENT', 'TEST');

-- CreateEnum
CREATE TYPE "WorkflowNodeExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "WorkflowErrorClass" AS ENUM ('RETRYABLE', 'TERMINAL', 'TIMEOUT', 'CANCELLED', 'LIMIT_EXCEEDED');

-- CreateTable
CREATE TABLE "workflow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "draftGraph" JSONB NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "publishedVersionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "graphHash" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'QUEUED',
    "origin" "WorkflowRunOrigin" NOT NULL,
    "triggerNodeId" TEXT NOT NULL,
    "input" JSONB,
    "correlationId" TEXT,
    "startedById" TEXT,
    "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "nodeExecutionCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "waitingSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_node_execution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "WorkflowNodeExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "firedHandles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "input" JSONB,
    "output" JSONB,
    "waitingOn" JSONB,
    "errorClass" "WorkflowErrorClass",
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "workItemId" TEXT,
    "aiRunId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "workflow_node_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_publishedVersionId_key" ON "workflow"("publishedVersionId");

-- CreateIndex
CREATE INDEX "workflow_workspaceId_enabled_idx" ON "workflow"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_workspaceId_name_key" ON "workflow"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_workflowId_version_key" ON "workflow_version"("workflowId", "version");

-- CreateIndex
CREATE INDEX "workflow_run_workflowId_createdAt_idx" ON "workflow_run"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "workflow_run_workspaceId_status_idx" ON "workflow_run"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "workflow_run_status_updatedAt_idx" ON "workflow_run"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_execution_idempotencyKey_key" ON "workflow_node_execution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "workflow_node_execution_runId_queuedAt_idx" ON "workflow_node_execution"("runId", "queuedAt");

-- CreateIndex
CREATE INDEX "workflow_node_execution_workItemId_idx" ON "workflow_node_execution"("workItemId");

-- CreateIndex
CREATE INDEX "workflow_node_execution_aiRunId_idx" ON "workflow_node_execution"("aiRunId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_node_execution_runId_nodeId_attempt_key" ON "workflow_node_execution"("runId", "nodeId", "attempt");

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "workflow_version"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "workflow_version"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_execution" ADD CONSTRAINT "workflow_node_execution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_execution" ADD CONSTRAINT "workflow_node_execution_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "work_item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_node_execution" ADD CONSTRAINT "workflow_node_execution_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A published version is immutable: a run that names it reads exactly the
-- graph it started on. Hand-written, because Prisma has no word for it, and
-- invisible to `migrate diff`, which compares tables rather than triggers.
CREATE FUNCTION "workflow_version_is_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."graph" IS DISTINCT FROM OLD."graph"
    OR NEW."graphHash" IS DISTINCT FROM OLD."graphHash"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."workflowId" IS DISTINCT FROM OLD."workflowId"
    OR NEW."draftRevision" IS DISTINCT FROM OLD."draftRevision" THEN
    RAISE EXCEPTION 'workflow_version % is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workflow_version_immutable"
  BEFORE UPDATE ON "workflow_version"
  FOR EACH ROW EXECUTE FUNCTION "workflow_version_is_immutable"();
