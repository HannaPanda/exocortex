-- Two more thinking levels (issue #67).
--
-- OpenRouter reports `reasoning.supported_efforts` per model, and the current
-- OpenAI models list `xhigh` and `max` above `high`. Without these values the
-- registry cannot store what the provider offers, so the two strongest levels
-- were silently unreachable.
--
-- Appended at the end of the type: an enum's declaration order is its sort
-- order in PostgreSQL, and these are the two strongest levels, so appending is
-- also the correct order. Nothing reads the type's order today -- ranking lives
-- in `REASONING_LEVEL_RANK` (`packages/contracts/src/ai-models.ts`).
--
-- Written by hand, like every migration here: `prisma migrate dev` wants to
-- drop and recreate the full-text search index it does not know about.

ALTER TYPE "AiReasoningLevel" ADD VALUE 'XHIGH';
ALTER TYPE "AiReasoningLevel" ADD VALUE 'MAX';
