-- A model's override of the deployment's OpenRouter provider preferences
-- (issue #135, ADR-063). Null inherits the setting `ai.providerRouting` as it is.
ALTER TABLE "ai_model" ADD COLUMN "providerRouting" JSONB;
