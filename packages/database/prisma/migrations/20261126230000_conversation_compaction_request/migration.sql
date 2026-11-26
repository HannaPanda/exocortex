-- A compaction a person asked for (issue #287): when it was asked for while
-- the worker has not finished, and why the last one left no summary.
ALTER TABLE "ai_conversation" ADD COLUMN "compactRequestedAt" TIMESTAMP(3);
ALTER TABLE "ai_conversation" ADD COLUMN "compactionError" TEXT;
