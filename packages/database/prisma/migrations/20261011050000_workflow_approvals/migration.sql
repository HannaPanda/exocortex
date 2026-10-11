-- Issue #163: an approval node in a workflow asks a person through an
-- ordinary attention item, which remembers the node attempt that raised it;
-- and a run that ends at an end node keeps what that node says about it.

-- AlterTable
ALTER TABLE "attention_item" ADD COLUMN     "workflowExecutionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "attention_item_workflowExecutionId_key" ON "attention_item"("workflowExecutionId");

-- AlterTable
ALTER TABLE "workflow_run" ADD COLUMN     "endNodeId" TEXT,
ADD COLUMN     "summary" TEXT;
