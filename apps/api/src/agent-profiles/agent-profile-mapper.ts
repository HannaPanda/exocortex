import {
  type AgentApprovalPolicy,
  type AgentProfile,
  type AgentProfileHistoryEntry,
  type AiReasoningLevel,
  type AiWriteMode,
} from '@exocortex/contracts';
import { type Prisma, storedProviderRouting, storedToolDomains } from '@exocortex/database';

/** What the mapper needs of a row: the profile, its two accounts, its open work. */
export const AGENT_PROFILE_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  instructions: true,
  ruleDocumentIds: true,
  modelSlug: true,
  reasoningLevel: true,
  providerRouting: true,
  toolDomains: true,
  writeMode: true,
  approvalPolicy: true,
  budgetMicroUsdPerRun: true,
  budgetMicroUsdPerTask: true,
  maxToolIterations: true,
  maxRunSeconds: true,
  confineToWorkspace: true,
  isDefault: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
  _count: { select: { workItems: { where: { closedAt: null } } } },
} satisfies Prisma.AgentProfileSelect;

export type AgentProfileRow = Prisma.AgentProfileGetPayload<{
  select: typeof AGENT_PROFILE_SELECT;
}>;

export function toAgentProfile(
  row: AgentProfileRow,
  ruleTitles: ReadonlyMap<string, string>,
): AgentProfile {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    ruleDocuments: row.ruleDocumentIds.map((documentId) => ({
      documentId,
      title: ruleTitles.get(documentId) ?? null,
    })),
    modelSlug: row.modelSlug,
    reasoningLevel:
      row.reasoningLevel === null ? null : (row.reasoningLevel.toLowerCase() as AiReasoningLevel),
    providerRouting: storedProviderRouting(row.providerRouting),
    toolDomains: storedToolDomains(row.toolDomains),
    writeMode: row.writeMode.toLowerCase() as AiWriteMode,
    approvalPolicy: row.approvalPolicy.toLowerCase() as AgentApprovalPolicy,
    budgetMicroUsdPerRun: row.budgetMicroUsdPerRun,
    budgetMicroUsdPerTask: row.budgetMicroUsdPerTask,
    maxToolIterations: row.maxToolIterations,
    maxRunSeconds: row.maxRunSeconds,
    confineToWorkspace: row.confineToWorkspace,
    isDefault: row.isDefault,
    revision: row.revision,
    workItemCount: row._count.workItems,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** An audit row about a profile, as the history shows it. */
export function toHistoryEntry(row: {
  action: string;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  actor: { id: string; name: string | null } | null;
}): AgentProfileHistoryEntry {
  const metadata =
    row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const fields = typeof metadata.fields === 'string' ? metadata.fields.split(',') : [];
  const action = row.action.replace('agent_profile.', '') as AgentProfileHistoryEntry['action'];
  return {
    action,
    actor: row.actor,
    revision: typeof metadata.revision === 'number' ? metadata.revision : null,
    fields: fields.filter((field) => field.length > 0),
    createdAt: row.createdAt.toISOString(),
  };
}
