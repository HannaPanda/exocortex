import { type AiRunDiagnosis, type deriveAiRunTimeouts } from '@exocortex/contracts';

import { type RunFailure } from './contract';

type RunTimeouts = Pick<ReturnType<typeof deriveAiRunTimeouts>, 'turnTimeoutMs' | 'runBudgetMs'>;

/** Says which limit ran out, from what the run had done by then (ADR-059). */
export type DescribeTimeout = (limit: 'turn' | 'run', limitMs: number) => AiRunDiagnosis;

/** Why the run's abort controller fired; `null` when something else threw. */
export type AbortReason = 'run_budget' | 'turn_timeout' | 'cancelled' | null;

/** Turns a thrown abort into the failure it actually was. */
export function abortFailure(input: {
  reason: AbortReason;
  error: unknown;
  timeouts: RunTimeouts;
  describe: DescribeTimeout;
}): RunFailure {
  const { timeouts, describe } = input;
  if (input.reason === 'cancelled') {
    return { code: 'ai_cancelled', message: 'The run was cancelled' };
  }
  if (input.reason === 'turn_timeout') {
    return {
      code: 'ai_timeout',
      message: `A single model answer exceeded ${timeouts.turnTimeoutMs}ms`,
      diagnosis: describe('turn', timeouts.turnTimeoutMs),
    };
  }
  if (input.reason === 'run_budget') {
    return {
      code: 'ai_timeout',
      message: `The run exceeded its budget of ${timeouts.runBudgetMs}ms`,
      diagnosis: describe('run', timeouts.runBudgetMs),
    };
  }
  return {
    code: 'ai_provider_unavailable',
    message: input.error instanceof Error ? input.error.message : String(input.error),
  };
}

/** The run's own deadline passed between two steps rather than during one. */
export function runTimeoutFailure(timeouts: RunTimeouts, describe: DescribeTimeout): RunFailure {
  return {
    code: 'ai_timeout',
    message: `AI run exceeded its budget of ${timeouts.runBudgetMs}ms`,
    diagnosis: describe('run', timeouts.runBudgetMs),
  };
}

export function budgetFailure(budgetMicroUsd: number): RunFailure {
  return {
    code: 'ai_budget_exceeded',
    message: `AI run would exceed its budget of ${budgetMicroUsd} micro-USD`,
  };
}
