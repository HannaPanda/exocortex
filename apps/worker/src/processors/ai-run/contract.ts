import { type AiGenerateResult, type AiToolCall } from '@exocortex/ai';
import { type AiUsage } from '@exocortex/contracts';
import { type AiReasoningLevel as AiReasoningLevelPrisma } from '@exocortex/database';

/** Fields read directly from `ai_model` -- never imported from apps/api (rule 6/package boundaries). */
export interface ResolvedModelRow {
  id: string;
  slug: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: readonly AiReasoningLevelPrisma[];
  /** Slug of the vision companion, or null when the model sees images itself or none is configured. */
  visionCompanionSlug: string | null;
  /**
   * Micro-USD per million tokens, as the registry has them. Null when this run
   * names a model the registry does not know: an unknown model has no price,
   * and guessing one would put invented money into the usage view (issue #10).
   */
  inputMicroUsdPerMTok: number | null;
  outputMicroUsdPerMTok: number | null;
}

/** Why a run ended without an answer. */
export interface RunFailure {
  code: string;
  message: string;
}

/** What one exchange with the provider produced. */
export interface TurnResult {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage | null;
  failure: RunFailure | null;
  /**
   * Why the provider stopped. `'length'` means the output cap ended the turn,
   * which is the one case a finished-looking turn must never be mistaken for:
   * the text stops mid-sentence and a tool call stops mid-JSON.
   */
  finishReason: AiGenerateResult['finishReason'];
}

/**
 * Adds one turn's usage to the run's running total.
 *
 * Costs are summed rather than replaced because a run is often several turns,
 * and a caller looking at `usage` wants what the whole answer cost, not what
 * its last exchange did.
 */
export function addUsage(total: AiUsage | null, turn: AiUsage): AiUsage {
  if (total === null) return { ...turn };
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cachedInputTokens: total.cachedInputTokens + turn.cachedInputTokens,
    provider: turn.provider,
    model: turn.model,
    providerCostMicroUsd:
      total.providerCostMicroUsd === null && turn.providerCostMicroUsd === null
        ? null
        : (total.providerCostMicroUsd ?? 0) + (turn.providerCostMicroUsd ?? 0),
    durationMs: total.durationMs + turn.durationMs,
  };
}
