-- Issue #146, ADR-074: eval cases, eval runs and their attempts, and the
-- attempt each run of the built-in AI is, when it is one.

-- CreateEnum
CREATE TYPE "EvalReplayMode" AS ENUM ('READ_ONLY', 'PROPOSE', 'FIXTURE');

-- CreateEnum
CREATE TYPE "EvalAttemptStatus" AS ENUM ('QUEUED', 'RUNNING', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvalOutcome" AS ENUM ('PASSED', 'FAILED', 'INVARIANT_VIOLATED', 'ERROR');

-- CreateEnum
CREATE TYPE "EvalVerdict" AS ENUM ('PASSED', 'FAILED');

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN     "evalAttemptId" TEXT;

-- CreateTable
CREATE TABLE "eval_case" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "suite" TEXT,
    "prompt" TEXT NOT NULL,
    "replayMode" "EvalReplayMode" NOT NULL,
    "documentId" TEXT,
    "fixture" JSONB,
    "agentProfileId" TEXT,
    "toolDomains" JSONB,
    "budgetMicroUsd" INTEGER,
    "maxToolIterations" INTEGER,
    "maxRunSeconds" INTEGER,
    "invariants" JSONB NOT NULL DEFAULT '[]',
    "criteria" JSONB NOT NULL DEFAULT '[]',
    "expectedOutcome" TEXT,
    "sourceRunId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "eval_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_run" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT,
    "suite" TEXT,
    "variants" JSONB NOT NULL,
    "repetitions" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_attempt" (
    "id" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "caseId" TEXT,
    "caseRevision" INTEGER NOT NULL,
    "caseSnapshot" JSONB NOT NULL,
    "variant" JSONB NOT NULL,
    "variantLabel" TEXT NOT NULL,
    "repetition" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "EvalAttemptStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" "EvalOutcome",
    "errorCode" TEXT,
    "aiRunId" TEXT,
    "conversationId" TEXT,
    "sandboxDocumentId" TEXT,
    "sandboxPages" JSONB,
    "metrics" JSONB,
    "assertions" JSONB NOT NULL DEFAULT '[]',
    "artifacts" JSONB,
    "answer" TEXT,
    "reviewVerdict" "EvalVerdict",
    "reviewScore" INTEGER,
    "reviewNote" TEXT,
    "reviewManual" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "eval_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eval_case_workspaceId_suite_idx" ON "eval_case"("workspaceId", "suite");

-- CreateIndex
CREATE UNIQUE INDEX "eval_case_workspaceId_name_key" ON "eval_case"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "eval_run_workspaceId_createdAt_idx" ON "eval_run"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "eval_attempt_aiRunId_key" ON "eval_attempt"("aiRunId");

-- CreateIndex
CREATE INDEX "eval_attempt_evalRunId_position_idx" ON "eval_attempt"("evalRunId", "position");

-- CreateIndex
CREATE INDEX "eval_attempt_caseId_createdAt_idx" ON "eval_attempt"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "eval_attempt_status_idx" ON "eval_attempt"("status");

-- CreateIndex
CREATE INDEX "eval_attempt_sandboxDocumentId_idx" ON "eval_attempt"("sandboxDocumentId");

-- AddForeignKey
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_attempt" ADD CONSTRAINT "eval_attempt_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "eval_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_attempt" ADD CONSTRAINT "eval_attempt_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "eval_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_attempt" ADD CONSTRAINT "eval_attempt_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_attempt" ADD CONSTRAINT "eval_attempt_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

