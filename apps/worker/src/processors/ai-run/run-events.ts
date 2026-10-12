import { type AiRunEventData } from '@exocortex/contracts';

import { type ToolCallOutcome } from '../../tool-runner';

import { type TurnResult } from './contract';

/**
 * The run loop's steps as the run inspector keeps them (issue #145, ADR-073):
 * sizes, names and outcomes, never the text of a turn or a tool answer.
 */

/** One exchange with the provider. */
export function turnEvent(input: {
  index: number;
  turn: TurnResult;
  runModel: string;
  eligibleProviders: number | null;
  reasoned: boolean;
}): AiRunEventData {
  const { turn } = input;
  return {
    kind: 'turn',
    data: {
      index: input.index,
      model: turn.usage?.model ?? input.runModel,
      servedBy: turn.usage?.servedBy ?? null,
      provider: turn.usage?.provider ?? null,
      firstTokenMs: turn.usage?.firstTokenMs ?? null,
      eligibleProviders: input.eligibleProviders,
      finishReason: turn.finishReason,
      inputTokens: turn.usage?.inputTokens ?? null,
      outputTokens: turn.usage?.outputTokens ?? null,
      cachedInputTokens: turn.usage?.cachedInputTokens ?? null,
      costMicroUsd: turn.usage?.providerCostMicroUsd ?? null,
      toolCalls: turn.toolCalls.length,
      reasoned: input.reasoned,
      outputChars: turn.text.length,
      failureCode: turn.failure?.code ?? null,
    },
  };
}

/**
 * One tool call: what it touched and how it ended. `result` is null for a
 * call the provider never delivered whole, which was never executed.
 */
export function toolCallEvent(input: {
  iteration: number;
  toolName: string;
  target: string | null;
  result: ToolCallOutcome | null;
  /** An earlier call of the same turn paused the run, so this one was not executed. */
  skipped: boolean;
}): AiRunEventData {
  const { result } = input;
  const status =
    result === null
      ? 'undelivered'
      : input.skipped
        ? 'skipped'
        : result.refused
          ? 'refused'
          : result.isError
            ? 'failed'
            : 'succeeded';
  return {
    kind: 'tool_call',
    data: {
      iteration: input.iteration,
      toolName: input.toolName,
      status,
      target: input.target,
      resultChars: result?.text.length ?? 0,
      resultTruncated: result?.resultTruncated ?? false,
      untrustedOrigin: result?.untrustedOrigin ?? null,
      repeated: result?.repeated ?? false,
      pausedRun: result?.pausesRun === true,
    },
  };
}
