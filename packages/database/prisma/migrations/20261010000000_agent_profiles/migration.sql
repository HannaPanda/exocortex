-- Issue #143, ADR-071: agent profiles, the profile a work item's runs use,
-- and the profile each run worked under.

-- CreateEnum
CREATE TYPE "AgentApprovalPolicy" AS ENUM ('NONE', 'REVIEW_BEFORE_DONE');

-- CreateTable
CREATE TABLE "agent_profile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "ruleDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "modelSlug" TEXT,
    "reasoningLevel" "AiReasoningLevel",
    "providerRouting" JSONB,
    "toolDomains" JSONB,
    "writeMode" "AiWriteMode" NOT NULL DEFAULT 'PROPOSE',
    "approvalPolicy" "AgentApprovalPolicy" NOT NULL DEFAULT 'NONE',
    "budgetMicroUsdPerRun" INTEGER,
    "budgetMicroUsdPerTask" INTEGER,
    "maxToolIterations" INTEGER,
    "maxRunSeconds" INTEGER,
    "confineToWorkspace" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_workspaceId_name_key" ON "agent_profile"("workspaceId", "name");

-- At most one default profile per workspace. Partial, so Prisma cannot say it.
CREATE UNIQUE INDEX "agent_profile_one_default_per_workspace" ON "agent_profile"("workspaceId") WHERE "isDefault";

-- AddForeignKey
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_profile" ADD CONSTRAINT "agent_profile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "work_item" ADD COLUMN "agentProfileId" TEXT;
CREATE INDEX "work_item_agentProfileId_idx" ON "work_item"("agentProfileId");
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "agent_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ai_run" ADD COLUMN "agentProfileId" TEXT,
ADD COLUMN "agentProfileSnapshot" JSONB;
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "agent_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
