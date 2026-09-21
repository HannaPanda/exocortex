-- What a run was offered, and what that weighed (issue #121).
--
-- The built-in loop used to be handed the whole catalogue in every turn. It is
-- handed the domains the task needs now, and these columns are what turns that
-- into a measurement: tools offered, characters of serialized schema, the
-- domains behind them, and the calls the run actually made.
--
-- Nullable where a run may honestly have no answer (a run without tools), with
-- a default where zero is the truth. No index: they are read per run and
-- aggregated over a report, never filtered on.
ALTER TABLE "ai_run" ADD COLUMN "toolCalls" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ai_run" ADD COLUMN "toolsOffered" INTEGER;
ALTER TABLE "ai_run" ADD COLUMN "toolSchemaChars" INTEGER;
ALTER TABLE "ai_run" ADD COLUMN "toolDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
