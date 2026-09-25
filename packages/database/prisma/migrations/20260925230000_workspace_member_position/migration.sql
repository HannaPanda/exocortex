-- A person's own order of their workspaces.
--
-- On the membership, because the order belongs to one person: moving a
-- workspace to the end of my list must not move it in anybody else's. NULL
-- means never placed, and those memberships keep following the placed ones
-- oldest first, so nobody's list changes until they reorder it.
-- AlterTable
ALTER TABLE "workspace_member" ADD COLUMN "position" INTEGER;
