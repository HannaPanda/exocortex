import { type AiToolCall } from '@exocortex/ai';

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
