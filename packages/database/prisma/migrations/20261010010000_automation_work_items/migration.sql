-- Issue #143, ADR-071: an automation can hand work over, under an agent profile.

-- AlterEnum
ALTER TYPE "AutomationAction" ADD VALUE 'WORK_ITEM';

-- AlterTable
ALTER TABLE "automation_rule" ADD COLUMN "agentProfileId" TEXT,
ADD COLUMN "startWorkItemRun" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "automation_rule" ADD CONSTRAINT "automation_rule_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "agent_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
