import {
  type AgentApprovalPolicy,
  type AgentProfileSnapshot,
  type AiReasoningLevel,
  type AiWriteMode,
  type ProviderRoutingOverride,
  providerRoutingOverrideSchema,
  stricterLimit,
  type ToolDomain,
  toolDomainSchema,
} from '@exocortex/contracts';

import { type AgentProfile, type PrismaClient, type PrismaTransactionClient } from './client';

/**
 * Which agent profile a piece of work runs under (issue #143, ADR-071),
 * shared by the API (which starts runs and checks budgets) and the worker
 * (which holds the run to the profile).
 *
 * One rule in two processes: the work item's own profile, or else the
 * workspace's default, or else none. A profile id that points into another
 * workspace is treated as none, because a foreign key cannot say "same
 * workspace" and a profile must never travel.
 */
export interface ResolvedAgentProfile {
  row: AgentProfile;
  source: AgentProfileSnapshot['source'];
}

export async function resolveAgentProfile(
  prisma: PrismaClient | PrismaTransactionClient,
  input: { workspaceId: string; agentProfileId: string | null },
): Promise<ResolvedAgentProfile | null> {
  if (input.agentProfileId !== null) {
    const own = await prisma.agentProfile.findUnique({ where: { id: input.agentProfileId } });
    if (own !== null && own.workspaceId === input.workspaceId) {
      return { row: own, source: 'work_item' };
    }
  }
  const fallback = await prisma.agentProfile.findFirst({
    where: { workspaceId: input.workspaceId, isDefault: true },
  });
  return fallback === null ? null : { row: fallback, source: 'default' };
}

/** The column's lowercase spelling of an enum value, typed. */
function lower<T extends string>(value: string): T {
  return value.toLowerCase() as T;
}

/** A stored domain list, with anything no longer in the vocabulary dropped. */
export function storedToolDomains(value: unknown): ToolDomain[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const parsed = toolDomainSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** A stored routing override, or null when there is none or it no longer parses. */
export function storedProviderRouting(value: unknown): ProviderRoutingOverride | null {
  if (value === null || value === undefined) return null;
  const parsed = providerRoutingOverrideSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What a run keeps about the profile it started under. */
export function agentProfileSnapshot(resolved: ResolvedAgentProfile): AgentProfileSnapshot {
  const { row } = resolved;
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    source: resolved.source,
    writeMode: lower<AiWriteMode>(row.writeMode),
    approvalPolicy: lower<AgentApprovalPolicy>(row.approvalPolicy),
    toolDomains: storedToolDomains(row.toolDomains),
    modelSlug: row.modelSlug,
    reasoningLevel:
      row.reasoningLevel === null ? null : lower<AiReasoningLevel>(row.reasoningLevel),
    budgetMicroUsdPerRun: row.budgetMicroUsdPerRun,
    budgetMicroUsdPerTask: row.budgetMicroUsdPerTask,
    maxToolIterations: row.maxToolIterations,
    maxRunSeconds: row.maxRunSeconds,
    confineToWorkspace: row.confineToWorkspace,
  };
}

/**
 * The budget a piece of work is held to: the stricter of its own and its
 * profile's per-task budget. Null when neither sets one.
 */
export function effectiveTaskBudget(
  itemBudgetMicroUsd: number | null,
  profile: Pick<AgentProfile, 'budgetMicroUsdPerTask'> | null,
): number | null {
  return stricterLimit(itemBudgetMicroUsd, profile?.budgetMicroUsdPerTask ?? null);
}
