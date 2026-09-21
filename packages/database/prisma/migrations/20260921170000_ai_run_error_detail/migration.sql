-- A failed run keeps what went wrong, not only which kind of wrong it was
-- (issue #118, ADR-059). Nullable and unindexed: it is read when somebody
-- opens one run, never filtered on.
ALTER TABLE "ai_run" ADD COLUMN "errorDetail" TEXT;
