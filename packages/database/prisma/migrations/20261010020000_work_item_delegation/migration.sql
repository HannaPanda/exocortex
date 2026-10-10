-- Issue #144, ADR-072: delegation as child work items, and a parent that waits for them.

-- AlterEnum
ALTER TYPE "WorkItemEventKind" ADD VALUE 'DELEGATED';
ALTER TYPE "WorkItemEventKind" ADD VALUE 'CHILDREN_AWAITED';
ALTER TYPE "WorkItemEventKind" ADD VALUE 'CHILDREN_RETURNED';

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN "awaitingChildIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "awaitingRunId" TEXT,
ADD COLUMN "awaitingSince" TIMESTAMP(3);
