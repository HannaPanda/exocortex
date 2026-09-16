-- Endpoint snapshots for context-aware provider routing (issue #68, ADR-032).
--
-- A model on OpenRouter is served by many providers at once and they differ:
-- the same GLM 5.3 is offered with a 262k window by one provider and a 1.3M
-- window by another. Collapsing that into a single number on `ai_model` meant
-- either compacting four times too early or sending a prompt no provider could
-- serve. The snapshot is what lets a request name the providers that fit.
--
-- `aliasTargetSlug` says what an `~vendor/model-latest` row's figures describe;
-- the slug itself stays the alias, so it keeps moving with the family.
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TABLE "ai_model"
  ADD COLUMN "aliasTargetSlug" TEXT,
  ADD COLUMN "endpointsSyncedAt" TIMESTAMP(3),
  -- Set when a run saw an alias answer as a different model than the snapshot
  -- describes. The scheduled refresh takes these first and clears the mark.
  ADD COLUMN "endpointsStaleSince" TIMESTAMP(3);

CREATE TABLE "ai_model_endpoint" (
  "id" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "providerKey" TEXT NOT NULL,
  "providerName" TEXT NOT NULL,
  "targetSlug" TEXT NOT NULL,
  "contextWindowTokens" INTEGER NOT NULL,
  "maxPromptTokens" INTEGER,
  "maxOutputTokens" INTEGER,
  "inputMicroUsdPerMTok" INTEGER NOT NULL,
  "outputMicroUsdPerMTok" INTEGER NOT NULL,
  "supportsTools" BOOLEAN NOT NULL DEFAULT false,
  "supportsReasoningEffort" BOOLEAN NOT NULL DEFAULT false,
  "quantization" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_model_endpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_model_endpoint_modelId_providerKey_key"
  ON "ai_model_endpoint" ("modelId", "providerKey");

-- The planner reads one model's endpoints, largest window first.
CREATE INDEX "ai_model_endpoint_modelId_contextWindowTokens_idx"
  ON "ai_model_endpoint" ("modelId", "contextWindowTokens");

ALTER TABLE "ai_model_endpoint"
  ADD CONSTRAINT "ai_model_endpoint_modelId_fkey"
  FOREIGN KEY ("modelId") REFERENCES "ai_model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
