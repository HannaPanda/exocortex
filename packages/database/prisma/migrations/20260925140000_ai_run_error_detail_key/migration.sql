-- The run diagnosis as facts (issue #98, ADR-059, ADR-062): a key of the
-- `diagnostics` namespace and its arguments, rendered in each reader's
-- language. `errorDetail` keeps the German rendering beside them, so rows
-- older than these columns read exactly as before.
ALTER TABLE "ai_run" ADD COLUMN "errorDetailKey" TEXT;
ALTER TABLE "ai_run" ADD COLUMN "errorDetailArgs" JSONB;
