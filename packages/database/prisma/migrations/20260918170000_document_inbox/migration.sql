-- Issue #71 (ADR-036): the workspace inbox is an ordinary page carrying a flag.
ALTER TABLE "document" ADD COLUMN "isInbox" BOOLEAN NOT NULL DEFAULT false;

-- One inbox per workspace, enforced where it belongs. The index is partial
-- because the flag is false on every row but one, and a partial index is
-- something the Prisma datamodel cannot describe: the migration gate carries
-- this name in its allow-list, and removing the index means removing the entry
-- there in the same commit.
CREATE UNIQUE INDEX "document_workspace_inbox_unique" ON "document" ("workspaceId") WHERE "isInbox";
