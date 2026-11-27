import { type AiToolCall } from '@exocortex/ai';
import { AI_RUN_PHASE_MIN_INTERVAL_MS, type AiRunPhase } from '@exocortex/contracts';

import { type RunExecutionInput } from './execution-types';
import { toolCallSubject } from './wire';

export type ToolCallStatus = 'started' | 'succeeded' | 'failed' | 'refused';

/**
 * Tells the workspace what a run's tool call is doing (issue #6): the tool,
 * its compact target and the page it is about, never its arguments.
 */
export async function publishToolCallEvent(
  input: Pick<RunExecutionInput, 'bus' | 'run' | 'payload'>,
  call: { iteration: number; call: AiToolCall; status: ToolCallStatus; target: string | null },
): Promise<void> {
  const { bus, run, payload } = input;
  const toolName = call.call.name;
  await bus.publish({
    type: 'ai.run.tool_call',
    workspaceId: run.workspaceId,
    correlationId: payload.correlationId,
    emittedAt: new Date().toISOString(),
    payload: {
      runId: run.id,
      iteration: call.iteration,
      toolName: toolName.length > 0 ? toolName : 'unbekannt',
      status: call.status,
      target: call.target,
      subject: toolCallSubject(call.call.name, call.call.argumentsJson),
    },
  });
}

/**
 * Names a phase that produces no text of its own, so a legitimate silence
 * (three minutes of it are allowed by `ai.timeoutMs`) is distinguishable from
 * a stall. Throttled per phase: reasoning arrives as a stream of tiny
 * fragments, and repeating "still thinking" for each one says nothing the
 * first one did not.
 */
export class PhasePublisher {
  private readonly lastPublishedAt = new Map<AiRunPhase, number>();

  constructor(private readonly input: Pick<RunExecutionInput, 'bus' | 'run' | 'payload'>) {}

  async publish(phase: AiRunPhase): Promise<void> {
    const { bus, run, payload } = this.input;
    const now = Date.now();
    const previous = this.lastPublishedAt.get(phase);
    if (previous !== undefined && now - previous < AI_RUN_PHASE_MIN_INTERVAL_MS) return;
    this.lastPublishedAt.set(phase, now);
    await bus.publish({
      type: 'ai.run.phase',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { runId: run.id, phase },
    });
  }
}
