-- Issue #189: the knowledge map's look is a person's taste, kept on the
-- account. NULL means the defaults.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "knowledgeMapAppearance" JSONB;
