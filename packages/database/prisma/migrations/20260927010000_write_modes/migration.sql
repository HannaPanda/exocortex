-- Issue #141, ADR-070: the write mode a work item's runs are held to, and
-- the one each run was held to.

-- CreateEnum
CREATE TYPE "AiWriteMode" AS ENUM ('READ_ONLY', 'PROPOSE', 'DIRECT');

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN     "writeMode" "AiWriteMode";

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN     "writeMode" "AiWriteMode";

