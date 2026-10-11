-- Issue #162: agent nodes in workflows hand their work to an ordinary work
-- item, which now carries the fields its result promises, the values, and
-- the workflow node attempt that created it.

-- AlterEnum
ALTER TYPE "WorkItemEventKind" ADD VALUE 'STRUCTURED_RESULT_RECORDED';

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "resultFields" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "structuredResult" JSONB,
ADD COLUMN     "workflowExecutionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "work_item_workflowExecutionId_key" ON "work_item"("workflowExecutionId");
