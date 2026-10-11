-- Issue #164: a run can carry a write-mode ceiling of its own. A test run
-- from the editor proposes by default, and every agent node of the run is
-- held to the stricter of this and its own mode.

-- AlterTable
ALTER TABLE "workflow_run" ADD COLUMN     "writeMode" "AiWriteMode";
