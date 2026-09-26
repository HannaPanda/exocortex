-- Issue #140, ADR-068: an attention item as a human checkpoint that pauses
-- the work and carries it on with the answer.

-- AlterEnum
ALTER TYPE "WorkItemEventKind" ADD VALUE 'RUN_RESUMED';
ALTER TYPE "WorkItemEventKind" ADD VALUE 'RESUME_FAILED';

-- AlterTable
ALTER TABLE "attention_item" ADD COLUMN "blocking" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "context" TEXT,
ADD COLUMN "action" TEXT,
ADD COLUMN "workState" TEXT,
ADD COLUMN "subject" JSONB;

-- A question about no work item never waited on anything.
UPDATE "attention_item" SET "blocking" = false WHERE "workItemId" IS NULL AND "system" = false;
