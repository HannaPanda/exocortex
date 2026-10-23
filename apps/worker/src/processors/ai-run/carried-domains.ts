import { aiRunToolCallEventDataSchema, TOOL_DOMAINS, type ToolDomain } from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';
import { ALWAYS_OFFERED_DOMAINS, findTool } from '@exocortex/mcp-tools';

/**
 * How many earlier runs of the conversation hand their domains on. The same
 * window as the words the selection reads (`taskTextFor`): a conversation
 * that moved on should stop carrying what it no longer does.
 */
export const CARRIED_RUNS = 3;

/** A call that never reached its tool says nothing about what the task needed. */
const CARRYING_STATUSES = new Set(['succeeded', 'failed']);

/**
 * The domains the last runs of this conversation actually used or opened
 * (issue #206).
 *
 * An `exo_toolbox` opening used to last one run. The next message of the same
 * conversation was offered only what its own words named, so "und die anderen
 * auch" after an archive was offered no archive tool: on 2026-10-23 one run
 * opened `lifecycle` and archived, and the three after it renamed a page
 * fifteen times instead. So what a run reached for is carried forward,
 * whoever chooses the rest of the offer.
 *
 * Read from the run timeline rather than from `ai_run.toolDomains`, which
 * also holds everything a run was merely offered: carrying that forward would
 * make every guess permanent.
 */
export async function carriedToolDomains(prisma: PrismaClient, run: AiRun): Promise<ToolDomain[]> {
  if (run.conversationId === null) return [];
  const earlier = await prisma.aiRun.findMany({
    where: {
      conversationId: run.conversationId,
      id: { not: run.id },
      createdAt: { lt: run.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    take: CARRIED_RUNS,
    select: { id: true },
  });
  if (earlier.length === 0) return [];
  const events = await prisma.aiRunEvent.findMany({
    where: { runId: { in: earlier.map((entry) => entry.id) }, kind: 'tool_call' },
    select: { data: true },
  });
  return domainsFromToolCalls(events.map((event) => event.data));
}

/** The domains a list of recorded tool calls reached, without the ones every run has. */
export function domainsFromToolCalls(data: readonly unknown[]): ToolDomain[] {
  const reached = new Set<ToolDomain>();
  for (const entry of data) {
    const parsed = aiRunToolCallEventDataSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (parsed.data.openedDomain !== undefined) reached.add(parsed.data.openedDomain);
    if (!CARRYING_STATUSES.has(parsed.data.status)) continue;
    const domain = findTool(parsed.data.toolName)?.domain;
    if (domain !== undefined) reached.add(domain);
  }
  return TOOL_DOMAINS.filter(
    (domain) =>
      reached.has(domain) && domain !== 'external' && !ALWAYS_OFFERED_DOMAINS.includes(domain),
  );
}
