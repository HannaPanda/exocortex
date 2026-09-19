-- Issue #74: a saved search, a smart view and a query block are one stored question.
CREATE TABLE "saved_query" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "iconColor" TEXT,
    "definition" JSONB NOT NULL,
    "display" JSONB NOT NULL,
    "inSidebar" BOOLEAN NOT NULL DEFAULT false,
    "orderKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_query_pkey" PRIMARY KEY ("id")
);

-- The navigation's list, and the workspace's list behind it.
-- The fractional order key is compared as a byte sequence (see
-- 20260804101500_order_key_c_collation): with the database's default collation
-- 'l' sorts before 'V', and the guarantee that a new key falls strictly
-- between its neighbours is gone.
ALTER TABLE "saved_query" ALTER COLUMN "orderKey" TYPE text COLLATE "C";

CREATE INDEX "saved_query_workspaceId_inSidebar_orderKey_idx" ON "saved_query"("workspaceId", "inSidebar", "orderKey");
CREATE INDEX "saved_query_createdById_idx" ON "saved_query"("createdById");
CREATE INDEX "saved_query_updatedById_idx" ON "saved_query"("updatedById");

ALTER TABLE "saved_query" ADD CONSTRAINT "saved_query_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "saved_query" ADD CONSTRAINT "saved_query_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "saved_query" ADD CONSTRAINT "saved_query_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
