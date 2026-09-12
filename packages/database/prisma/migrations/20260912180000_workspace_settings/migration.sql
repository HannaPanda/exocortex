-- Settings get a scope, and the memory area moves onto the workspace row
-- (issue #52, ADR-023).
--
-- Two changes that belong together: `workspace_setting` is the fourth
-- resolution layer under ADR-013 (defaults < env < setting < workspace_setting),
-- and `workspace.isMemory` replaces the deployment-wide `memory.workspaceId`
-- key, because recall and remember are handed a user and never a workspace.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

-- One workspace's overrides. No row means "inherit"; unsetting is a DELETE.
CREATE TABLE "workspace_setting" (
  "workspaceId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" TEXT,

  CONSTRAINT "workspace_setting_pkey" PRIMARY KEY ("workspaceId", "key")
);

ALTER TABLE "workspace_setting"
  ADD CONSTRAINT "workspace_setting_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspace" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The author survives as a null when the account goes: an override outlives
-- whoever set it, the same way a deployment-wide setting row does.
ALTER TABLE "workspace_setting"
  ADD CONSTRAINT "workspace_setting_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "user" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The memory area as a property of the row.
ALTER TABLE "workspace" ADD COLUMN "isMemory" BOOLEAN NOT NULL DEFAULT false;

-- Swept by three nightly jobs that now iterate over every memory area rather
-- than reading one configured id.
CREATE INDEX "workspace_isMemory_idx" ON "workspace" ("isMemory");

-- Carry the configured memory workspace over, then retire the key. Nothing is
-- lost if the row was never set: no workspace is marked and the feature is
-- simply unconfigured, which is the state a fresh deployment is in anyway.
UPDATE "workspace"
   SET "isMemory" = true
 WHERE "id" = (
   SELECT trim(both '"' from "value"::text)
     FROM "setting"
    WHERE "key" = 'memory.workspaceId'
      AND jsonb_typeof("value") = 'string'
 );

DELETE FROM "setting" WHERE "key" = 'memory.workspaceId';
