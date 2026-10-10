import {
  type AgentProfileSnapshot,
  type AiMessage,
  allowedToolDomains,
  type ProviderRoutingOverride,
  stricterLimit,
  type ToolDomain,
} from '@exocortex/contracts';
import {
  agentProfileSnapshot,
  type PrismaClient,
  resolveAgentProfile,
  storedProviderRouting,
} from '@exocortex/database';

/** The most characters a profile's role and rule pages may add to the prompt. */
const MAX_PROFILE_CHARS = 16_000;

/**
 * The agent profile a run works under (issue #143, ADR-071), as the worker
 * applies it.
 *
 * Read from the database when the run starts, never from the job payload,
 * for the reason the write mode is (ADR-070): nothing a request carried may
 * loosen what holds the run. Only a run on a work item has one; a chat turn
 * runs as before.
 */
export interface RunProfile {
  snapshot: AgentProfileSnapshot;
  instructions: string | null;
  ruleDocumentIds: string[];
  providerRouting: ProviderRoutingOverride | null;
}

export async function resolveRunProfile(input: {
  prisma: PrismaClient;
  run: { workItemId: string | null; workspaceId: string };
}): Promise<RunProfile | null> {
  if (input.run.workItemId === null) return null;
  const work = await input.prisma.workItem.findUnique({
    where: { id: input.run.workItemId },
    select: { agentProfileId: true },
  });
  if (work === null) return null;
  const resolved = await resolveAgentProfile(input.prisma, {
    workspaceId: input.run.workspaceId,
    agentProfileId: work.agentProfileId,
  });
  if (resolved === null) return null;
  return {
    snapshot: agentProfileSnapshot(resolved),
    instructions: resolved.row.instructions,
    ruleDocumentIds: resolved.row.ruleDocumentIds,
    providerRouting: storedProviderRouting(resolved.row.providerRouting),
  };
}

/**
 * The limits of a run with its profile laid over the deployment's: each the
 * stricter of the two, so a profile can only ever take something away.
 */
export function profileLimits(
  profile: RunProfile | null,
  base: { budgetMicroUsd: number; maxToolIterations: number; runBudgetMs: number },
): { budgetMicroUsd: number; maxToolIterations: number; runBudgetMs: number } {
  if (profile === null) return base;
  const { snapshot } = profile;
  return {
    budgetMicroUsd: stricterLimit(base.budgetMicroUsd, snapshot.budgetMicroUsdPerRun)!,
    maxToolIterations: stricterLimit(base.maxToolIterations, snapshot.maxToolIterations)!,
    runBudgetMs: stricterLimit(
      base.runBudgetMs,
      snapshot.maxRunSeconds === null ? null : snapshot.maxRunSeconds * 1_000,
    )!,
  };
}

/**
 * The tool domains a run under this profile may use, or null for all.
 *
 * Besides the profile's list and `core`: a run on a work item keeps the tools
 * that report on it and ask a person, and a proposing run the proposal tools,
 * because a run that cannot say how far it got, or hand in what it would
 * change, is a run that fails in silence.
 */
export function profileToolDomains(
  profile: RunProfile | null,
  needs: { onWorkItem: boolean; proposing: boolean },
): ToolDomain[] | null {
  if (profile === null) return null;
  const required: ToolDomain[] = [
    ...(needs.onWorkItem ? (['workItems', 'attention'] as const) : []),
    ...(needs.proposing ? (['changesets'] as const) : []),
  ];
  return allowedToolDomains(profile.snapshot.toolDomains, required);
}

/**
 * What the model is told about the role it works in: the profile's
 * instructions, then its rule pages, inside one budget.
 *
 * A rule page outside the run's workspace, archived or never materialised is
 * skipped rather than fatal, the same as an ALWAYS rule page.
 */
export async function profileMessage(input: {
  prisma: PrismaClient;
  profile: RunProfile | null;
  workspaceId: string;
}): Promise<AiMessage | null> {
  const { profile } = input;
  if (profile === null) return null;
  const parts: string[] = [`Du arbeitest in der Rolle „${profile.snapshot.name}“.`];
  if (profile.instructions !== null) parts.push(profile.instructions);

  if (profile.ruleDocumentIds.length > 0) {
    const rows = await input.prisma.document.findMany({
      where: {
        id: { in: profile.ruleDocumentIds },
        workspaceId: input.workspaceId,
        archivedAt: null,
      },
      select: { id: true, title: true, content: { select: { markdown: true, plainText: true } } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of profile.ruleDocumentIds) {
      const row = byId.get(id);
      const body = row?.content?.markdown ?? row?.content?.plainText ?? null;
      if (row === undefined || body === null || body.trim().length === 0) continue;
      parts.push(`## ${row.title}\n\n${body.trim()}`);
    }
  }

  const text = parts.join('\n\n');
  return {
    role: 'system',
    content:
      text.length > MAX_PROFILE_CHARS ? `${text.slice(0, MAX_PROFILE_CHARS)}\n\n[gekürzt]` : text,
  };
}
