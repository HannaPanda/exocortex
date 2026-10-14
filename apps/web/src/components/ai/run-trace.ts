import { type ToolActivityEntry } from './use-ai-run-tracker';

/**
 * What a run did, in the order it did it (issue #195): the model's thinking
 * per turn and the tool calls between the turns.
 *
 * Built only from what actually arrived: `ai.run.reasoning` for the thinking,
 * `ai.run.tool_call` and the retry phase for the rest. Nothing is generated to
 * fill a gap, and a run that produced neither has no trace at all.
 */
export type RunTraceStep =
  | { kind: 'reasoning'; key: string; turn: number; text: string }
  | { kind: 'tool'; key: string; entry: ToolActivityEntry };

/** The trace of a run that has ended, kept until the next one starts. */
export interface FinishedRunTrace {
  runId: string;
  steps: readonly RunTraceStep[];
}

/** Thinking of the same turn continues the open step; a new turn opens a new one. */
export function appendReasoning(
  steps: readonly RunTraceStep[],
  turn: number,
  delta: string,
): RunTraceStep[] {
  const last = steps[steps.length - 1];
  if (last?.kind === 'reasoning' && last.turn === turn) {
    return [...steps.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [
    ...steps,
    { kind: 'reasoning', key: `reasoning:${String(steps.length)}`, turn, text: delta },
  ];
}

/**
 * A tool call's outcome replaces the line that announced it, so one call is
 * one line that changes its state instead of two lines that say the same
 * thing twice. Matched to the oldest announcement of the same tool in the same
 * iteration that is still open, which keeps two parallel calls of one tool
 * apart in the order they were made.
 */
export function appendToolEvent(
  steps: readonly RunTraceStep[],
  iteration: number,
  event: Omit<ToolActivityEntry, 'key'>,
): RunTraceStep[] {
  if (event.status !== 'started' && event.status !== 'retried') {
    const index = steps.findIndex(
      (step) =>
        step.kind === 'tool' &&
        step.entry.status === 'started' &&
        step.entry.toolName === event.toolName &&
        step.key.startsWith(`tool:${String(iteration)}:`),
    );
    const announced = steps[index];
    if (announced?.kind === 'tool') {
      const next = [...steps];
      next[index] = {
        ...announced,
        entry: {
          ...announced.entry,
          status: event.status,
          target: event.target ?? announced.entry.target,
        },
      };
      return next;
    }
  }
  const key = `tool:${String(iteration)}:${String(steps.length)}`;
  return [...steps, { kind: 'tool', key, entry: { ...event, key } }];
}

export function toolEntries(steps: readonly RunTraceStep[]): ToolActivityEntry[] {
  return steps.flatMap((step) => (step.kind === 'tool' ? [step.entry] : []));
}

export function hasReasoning(steps: readonly RunTraceStep[]): boolean {
  return steps.some((step) => step.kind === 'reasoning');
}
