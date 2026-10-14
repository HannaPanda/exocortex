import { type DiscoveredMcpTool, type McpDiscovery } from '@exocortex/ai';
import {
  externalMcpFunctionName,
  type ExternalMcpToolProblem,
  MODEL_FUNCTION_NAME_MAX,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

/**
 * The pure half of a connection check (issue #196, ADR-086): what a discovery
 * means for the stored tools, decided without a database so it can be tested
 * line by line.
 *
 * Three outcomes per tool, and the middle one is the reason this file exists:
 *
 * - **new**: stored blocked. Nobody has looked at it yet.
 * - **changed**: the fingerprint moved. Whatever a person approved, this is
 *   not it any more, so it goes back to blocked in the same write that stores
 *   the new text. `approvedFingerprint` is kept, so the screen can say "was
 *   approved, has changed" rather than looking like a tool nobody ever saw.
 * - **gone**: no longer listed. Marked unavailable and blocked; kept, so an
 *   approval does not silently come back if the server lists it again with a
 *   different description.
 */

export function toolProblem(
  serverKey: string,
  tool: DiscoveredMcpTool,
): ExternalMcpToolProblem | null {
  if (tool.problem !== null) return tool.problem;
  if (externalMcpFunctionName(serverKey, tool.name).length > MODEL_FUNCTION_NAME_MAX) {
    return 'name_too_long';
  }
  return null;
}

export interface StoredToolState {
  id: string;
  name: string;
  fingerprint: string;
}

export interface ToolReconciliation {
  creates: Prisma.ExternalMcpToolCreateManyInput[];
  updates: { id: string; data: Prisma.ExternalMcpToolUpdateInput }[];
  goneIds: string[];
}

export function reconcileTools(input: {
  serverId: string;
  serverKey: string;
  discovery: McpDiscovery;
  stored: readonly StoredToolState[];
  now: Date;
}): ToolReconciliation {
  const byName = new Map(input.stored.map((tool) => [tool.name, tool]));
  const listed = new Set<string>();
  const result: ToolReconciliation = { creates: [], updates: [], goneIds: [] };

  for (const tool of input.discovery.tools) {
    listed.add(tool.name);
    const content = {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Prisma.InputJsonObject,
      hints: tool.hints as Prisma.InputJsonObject,
      fingerprint: tool.fingerprint,
      problem: toolProblem(input.serverKey, tool),
    };
    const existing = byName.get(tool.name);
    if (existing === undefined) {
      result.creates.push({
        serverId: input.serverId,
        name: tool.name,
        ...content,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      });
    } else if (existing.fingerprint !== tool.fingerprint) {
      result.updates.push({
        id: existing.id,
        data: { ...content, available: true, access: 'BLOCKED', lastSeenAt: input.now },
      });
    } else {
      // Same tool. `problem` is written again because it depends on the
      // server key as well as the tool, and `available` because it may have
      // been gone for a check.
      result.updates.push({
        id: existing.id,
        data: { problem: content.problem, available: true, lastSeenAt: input.now },
      });
    }
  }

  for (const tool of input.stored) {
    if (!listed.has(tool.name)) result.goneIds.push(tool.id);
  }
  return result;
}
