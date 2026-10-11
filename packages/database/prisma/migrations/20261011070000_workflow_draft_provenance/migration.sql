-- Issue #165: a draft records who wrote its graph and how the request
-- arrived (a person, an external agent session, a run of the built-in AI),
-- and a version keeps that record of the graph it froze. Existing drafts
-- and versions were written by their creator and updater in the browser.

-- AlterTable
ALTER TABLE "workflow" ADD COLUMN     "draftAgentLabel" TEXT,
ADD COLUMN     "draftAiRunId" TEXT,
ADD COLUMN     "draftAuthorId" TEXT,
ADD COLUMN     "draftAuthorKind" "WorkItemParticipantKind" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "draftAuthoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "workflow_version" ADD COLUMN     "draftAgentLabel" TEXT,
ADD COLUMN     "draftAiRunId" TEXT,
ADD COLUMN     "draftAuthorId" TEXT,
ADD COLUMN     "draftAuthorKind" "WorkItemParticipantKind" NOT NULL DEFAULT 'HUMAN';

UPDATE "workflow" SET "draftAuthorId" = COALESCE("updatedById", "createdById"), "draftAuthoredAt" = "updatedAt";
UPDATE "workflow_version" SET "draftAuthorId" = "publishedById";

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_draftAuthorId_fkey" FOREIGN KEY ("draftAuthorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_draftAuthorId_fkey" FOREIGN KEY ("draftAuthorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The record of who wrote a version's graph is as immutable as the graph.
-- The account id is left out on purpose: deleting the account sets it to
-- null, exactly as it does `publishedById`.
CREATE OR REPLACE FUNCTION "workflow_version_is_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."graph" IS DISTINCT FROM OLD."graph"
    OR NEW."graphHash" IS DISTINCT FROM OLD."graphHash"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."workflowId" IS DISTINCT FROM OLD."workflowId"
    OR NEW."draftRevision" IS DISTINCT FROM OLD."draftRevision"
    OR NEW."draftAuthorKind" IS DISTINCT FROM OLD."draftAuthorKind"
    OR NEW."draftAgentLabel" IS DISTINCT FROM OLD."draftAgentLabel"
    OR NEW."draftAiRunId" IS DISTINCT FROM OLD."draftAiRunId" THEN
    RAISE EXCEPTION 'workflow_version % is immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
