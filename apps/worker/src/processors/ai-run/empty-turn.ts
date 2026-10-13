import { AI_STREAM_INTERRUPTED } from '@exocortex/ai';
import { type AiRunDiagnosis, type AiRunIncompleteTurnArgs } from '@exocortex/contracts';

import { type RunFailure, type TurnResult } from './contract';

/**
 * A turn that produced nothing anyone can use: no text (nor any carried over
 * from a truncated turn), no tool call, and either a clean finish or a stream
 * that broke off. Any other failure keeps its own path, because it says
 * something else.
 */
export function isEmptyTurn(turn: TurnResult, carriedText: string): boolean {
  if (turn.text.length > 0 || turn.toolCalls.length > 0 || carriedText.length > 0) return false;
  if (turn.failure !== null) return turn.failure.code === AI_STREAM_INTERRUPTED;
  return turn.finishReason === 'stop';
}

export function incompleteTurnDiagnosis(facts: AiRunIncompleteTurnArgs): AiRunDiagnosis {
  return { key: 'incompleteTurn', args: { ...facts } };
}

/**
 * What a run ends on once its empty turns are spent: a broken stream keeps
 * the provider's own code, a clean finish with nothing in it gets its own,
 * and both carry the diagnosis the panel shows instead of an empty bubble
 * (2026-10-13, Cline Pass: "0 → 0").
 */
export function emptyTurnFailure(facts: AiRunIncompleteTurnArgs): RunFailure {
  const diagnosis = incompleteTurnDiagnosis(facts);
  return facts.interrupted
    ? {
        code: AI_STREAM_INTERRUPTED,
        message: `The provider broke off the same turn ${facts.attempts} times without an answer`,
        diagnosis,
      }
    : {
        code: 'ai_empty_answer',
        message: `The model finished the same turn ${facts.attempts} times without text or tool calls`,
        diagnosis,
      };
}
