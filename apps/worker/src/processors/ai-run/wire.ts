import { type AiReasoningOptions, type AiToolCall } from '@exocortex/ai';
import { type AiReasoningLevel as AiReasoningLevelPrisma } from '@exocortex/database';
import { findTool } from '@exocortex/mcp-tools';

/** The stored enum as the provider spells it. */
export const REASONING_LEVEL_TO_LOWER: Record<
  AiReasoningLevelPrisma,
  AiReasoningOptions['effort']
> = {
  NONE: 'none',
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
  MAX: 'max',
};

/**
 * Compact identifier of what a tool call touches, e.g. `document:<id>` for
 * `exo_page_write`, taken from the same `target` the catalogue already uses
 * for the confirmation gate (`packages/mcp-tools/src/tool.ts`). Never the
 * full argument payload, and never a thrown error: an unknown tool, invalid
 * JSON or a read-only tool without a target all just mean "nothing to show"
 * (issue #6).
 */
export function toolCallTarget(name: string, argumentsJson: string): string | null {
  const tool = findTool(name);
  if (tool === null) return null;
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson) as unknown;
  } catch {
    return null;
  }
  return tool.targetOf(args);
}

/** Wire shape a tool call takes on an assistant message, matching what the provider round-trips. */
export function toWireToolCalls(
  toolCalls: readonly AiToolCall[],
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.argumentsJson },
  }));
}
