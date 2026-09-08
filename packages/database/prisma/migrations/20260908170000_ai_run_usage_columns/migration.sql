-- Usage figures as columns on `ai_run` (issue #10).
--
-- Everything the usage view wants to count was already recorded per run, but
-- only inside the `usage` JSON, where every question needs a cast and no index
-- helps. This lifts the five figures out into columns, adds a second cost
-- column for the estimate, and adds the marker the retention sweep sets.
--
-- Purely additive: `usage` keeps its contents, nothing is dropped, no column
-- changes type. The backfill at the end is a single UPDATE over a table that
-- holds runs, not documents, so it is small.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "ai_run"
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "cachedInputTokens" INTEGER,
  ADD COLUMN "providerCostMicroUsd" INTEGER,
  ADD COLUMN "estimatedCostMicroUsd" INTEGER,
  ADD COLUMN "durationMs" INTEGER,
  ADD COLUMN "payloadsPrunedAt" TIMESTAMP(3);

-- The deployment-wide time series filters on time alone, across every
-- workspace, so neither existing index on this table can serve it.
CREATE INDEX "ai_run_createdAt_idx" ON "ai_run" ("createdAt");

-- Carry the existing runs over. Only rows that actually carry a usage object
-- are touched; a run that never reached the provider keeps NULL everywhere,
-- because zero would claim it reported nothing rather than nothing at all.
--
-- `estimatedCostMicroUsd` is deliberately left NULL for old rows: the estimate
-- is computed from the model's price at the time of the run, and that price is
-- not recoverable here. Backfilling it from today's price list would invent
-- history rather than recover it.
UPDATE "ai_run" SET
  "inputTokens"          = NULLIF("usage" ->> 'inputTokens', '')::integer,
  "outputTokens"         = NULLIF("usage" ->> 'outputTokens', '')::integer,
  "cachedInputTokens"    = NULLIF("usage" ->> 'cachedInputTokens', '')::integer,
  "providerCostMicroUsd" = NULLIF("usage" ->> 'providerCostMicroUsd', '')::integer,
  "durationMs"           = NULLIF("usage" ->> 'durationMs', '')::integer
WHERE "usage" IS NOT NULL AND jsonb_typeof("usage") = 'object';
