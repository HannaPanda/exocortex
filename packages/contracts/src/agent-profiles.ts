import { z } from 'zod';

import { aiReasoningLevelSchema } from './ai-models';
import { aiWriteModeSchema } from './ai-trust';
import { idSchema, isoDateTimeSchema } from './primitives';
import { providerRoutingOverrideSchema } from './provider-routing';

/**
 * Agent profiles (issue #143, ADR-071).
 *
 * A profile is a role the built-in AI works in: a developer, a researcher, an
 * archivist. It parameterises the one runner there is -- what the model is
 * told, which model it prefers, which tools it may use, how it may write, what
 * it may spend -- and it only ever narrows. Every limit is combined with the
 * workspace's settings and the work item's own by taking the stricter, and the
 * run still acts with the authority of the person it runs for.
 *
 * Three things the interface keeps apart, because they are different
 * decisions: the profile (the role), the model (which one it prefers) and the
 * provider (who serves that model, which is routing configuration, ADR-063).
 */

/**
 * The parts of the tool catalogue (issue #121).
 *
 * Here rather than in `@exocortex/mcp-tools` since issue #143: a profile names
 * the domains its runs may use, and the API has to validate that list without
 * depending on the catalogue, which depends on the API's contracts.
 */
export const TOOL_DOMAINS = [
  'core',
  'pages',
  'history',
  'lifecycle',
  'appearance',
  'inbox',
  'comments',
  'databases',
  'attachments',
  'templates',
  'savedQueries',
  'workItems',
  'attention',
  'changesets',
  'evals',
  'workflows',
  'shares',
  'entities',
  'memory',
  'chats',
  'automations',
  'notifications',
  'projects',
  'render',
  'web',
  'admin',
] as const;
export const toolDomainSchema = z.enum(TOOL_DOMAINS);
export type ToolDomain = z.infer<typeof toolDomainSchema>;

/**
 * The domains a run under a profile always keeps, whatever the profile lists.
 *
 * `core` is navigating, searching and reading rules: a profile without it
 * could not find the page it was asked about. A run on a work item also keeps
 * the tools that report on it and ask a person (`workItems`, `attention`),
 * and a proposing run the proposal tools; the worker adds those, because
 * only it knows what kind of run it is.
 */
export const PROFILE_ALWAYS_ALLOWED_DOMAINS: readonly ToolDomain[] = ['core'];

/** Whether a run under a profile may close its work itself. */
export const AGENT_APPROVAL_POLICIES = ['none', 'review_before_done'] as const;
export const agentApprovalPolicySchema = z.enum(AGENT_APPROVAL_POLICIES);
export type AgentApprovalPolicy = z.infer<typeof agentApprovalPolicySchema>;

export const AGENT_PROFILE_LIMITS = {
  nameMaxChars: 80,
  descriptionMaxChars: 500,
  instructionsMaxChars: 8_000,
  maxRuleDocuments: 10,
  maxToolIterations: 100,
  minRunSeconds: 30,
  maxRunSeconds: 3_600,
} as const;

/** Millionths of a dollar, the unit every cost column here uses. */
const budgetSchema = z.number().int().min(0).max(1_000_000_000);
const nameSchema = z.string().trim().min(1).max(AGENT_PROFILE_LIMITS.nameMaxChars);
const descriptionSchema = z.string().trim().max(AGENT_PROFILE_LIMITS.descriptionMaxChars);
const instructionsSchema = z.string().trim().max(AGENT_PROFILE_LIMITS.instructionsMaxChars);
const ruleIdsSchema = z.array(idSchema).max(AGENT_PROFILE_LIMITS.maxRuleDocuments);
const toolDomainsSchema = z.array(toolDomainSchema).max(TOOL_DOMAINS.length);
const iterationsSchema = z.number().int().min(1).max(AGENT_PROFILE_LIMITS.maxToolIterations);
const runSecondsSchema = z
  .number()
  .int()
  .min(AGENT_PROFILE_LIMITS.minRunSeconds)
  .max(AGENT_PROFILE_LIMITS.maxRunSeconds);
const modelSlugSchema = z.string().trim().min(1).max(200);

const accountSchema = z.object({ id: idSchema, name: z.string().nullable() });

export const agentProfileSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  instructions: z.string().nullable(),
  /** Rule pages added to the role; `title` is null for a page that is gone. */
  ruleDocuments: z.array(z.object({ documentId: idSchema, title: z.string().nullable() })),
  /** A preference: skipped when that model is not enabled any more. */
  modelSlug: z.string().nullable(),
  reasoningLevel: aiReasoningLevelSchema.nullable(),
  /** Laid over the configured provider routing key by key (ADR-063). */
  providerRouting: providerRoutingOverrideSchema.nullable(),
  /** Null means every domain. */
  toolDomains: z.array(toolDomainSchema).nullable(),
  writeMode: aiWriteModeSchema,
  approvalPolicy: agentApprovalPolicySchema,
  budgetMicroUsdPerRun: z.number().int().nullable(),
  budgetMicroUsdPerTask: z.number().int().nullable(),
  maxToolIterations: z.number().int().nullable(),
  maxRunSeconds: z.number().int().nullable(),
  confineToWorkspace: z.boolean(),
  isDefault: z.boolean(),
  revision: z.number().int(),
  /** Open work items that name this profile. */
  workItemCount: z.number().int(),
  createdBy: accountSchema.nullable(),
  updatedBy: accountSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** One change to a profile, out of the audit log. */
export const agentProfileHistoryEntrySchema = z.object({
  action: z.enum(['created', 'updated', 'deleted']),
  actor: accountSchema.nullable(),
  revision: z.number().int().nullable(),
  /** The fields an update touched; empty for the other actions. */
  fields: z.array(z.string()),
  createdAt: isoDateTimeSchema,
});
export type AgentProfileHistoryEntry = z.infer<typeof agentProfileHistoryEntrySchema>;

export const agentProfileResponseSchema = z.object({
  profile: agentProfileSchema,
  /** Newest first; present on the detail read, empty after a write. */
  history: z.array(agentProfileHistoryEntrySchema),
});
export type AgentProfileResponse = z.infer<typeof agentProfileResponseSchema>;

export const agentProfileListResponseSchema = z.object({
  profiles: z.array(agentProfileSchema),
});
export type AgentProfileListResponse = z.infer<typeof agentProfileListResponseSchema>;

export const createAgentProfileRequestSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.nullable().optional(),
  instructions: instructionsSchema.nullable().optional(),
  ruleDocumentIds: ruleIdsSchema.optional(),
  modelSlug: modelSlugSchema.nullable().optional(),
  reasoningLevel: aiReasoningLevelSchema.nullable().optional(),
  providerRouting: providerRoutingOverrideSchema.nullable().optional(),
  toolDomains: toolDomainsSchema.nullable().optional(),
  /** `propose` when left out: a new role starts careful. */
  writeMode: aiWriteModeSchema.optional(),
  approvalPolicy: agentApprovalPolicySchema.optional(),
  budgetMicroUsdPerRun: budgetSchema.nullable().optional(),
  budgetMicroUsdPerTask: budgetSchema.nullable().optional(),
  maxToolIterations: iterationsSchema.nullable().optional(),
  maxRunSeconds: runSecondsSchema.nullable().optional(),
  confineToWorkspace: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type CreateAgentProfileRequest = z.infer<typeof createAgentProfileRequestSchema>;

/** A partial update: an absent field is left alone, `null` clears it. */
export const updateAgentProfileRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    instructions: instructionsSchema.nullable().optional(),
    ruleDocumentIds: ruleIdsSchema.optional(),
    modelSlug: modelSlugSchema.nullable().optional(),
    reasoningLevel: aiReasoningLevelSchema.nullable().optional(),
    providerRouting: providerRoutingOverrideSchema.nullable().optional(),
    toolDomains: toolDomainsSchema.nullable().optional(),
    writeMode: aiWriteModeSchema.optional(),
    approvalPolicy: agentApprovalPolicySchema.optional(),
    budgetMicroUsdPerRun: budgetSchema.nullable().optional(),
    budgetMicroUsdPerTask: budgetSchema.nullable().optional(),
    maxToolIterations: iterationsSchema.nullable().optional(),
    maxRunSeconds: runSecondsSchema.nullable().optional(),
    confineToWorkspace: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateAgentProfileRequest = z.infer<typeof updateAgentProfileRequestSchema>;

export const duplicateAgentProfileRequestSchema = z.object({ name: nameSchema });
export type DuplicateAgentProfileRequest = z.infer<typeof duplicateAgentProfileRequestSchema>;

export const deleteAgentProfileResponseSchema = z.object({
  deleted: z.literal(true),
  /** Work items that named it and now use the workspace's default again. */
  detachedWorkItems: z.number().int(),
});
export type DeleteAgentProfileResponse = z.infer<typeof deleteAgentProfileResponseSchema>;

/**
 * What a profile said when a run started under it, kept on the run.
 *
 * `source` says how the run came to it: named by its work item, or the
 * workspace's default for work that names none.
 */
export const agentProfileSnapshotSchema = z.object({
  id: idSchema,
  name: z.string(),
  revision: z.number().int(),
  /** `eval_case`: named by the eval case an attempt replays (issue #146). */
  source: z.enum(['work_item', 'default', 'eval_case']),
  writeMode: aiWriteModeSchema,
  approvalPolicy: agentApprovalPolicySchema,
  toolDomains: z.array(toolDomainSchema).nullable(),
  modelSlug: z.string().nullable(),
  reasoningLevel: aiReasoningLevelSchema.nullable(),
  budgetMicroUsdPerRun: z.number().int().nullable(),
  budgetMicroUsdPerTask: z.number().int().nullable(),
  maxToolIterations: z.number().int().nullable(),
  maxRunSeconds: z.number().int().nullable(),
  confineToWorkspace: z.boolean(),
});
export type AgentProfileSnapshot = z.infer<typeof agentProfileSnapshotSchema>;

/** A profile as the work item and the run name it. */
export const agentProfileRefSchema = z.object({
  id: idSchema.nullable(),
  name: z.string(),
  /** True when it is the workspace's default rather than the item's own choice. */
  inherited: z.boolean(),
});
export type AgentProfileRef = z.infer<typeof agentProfileRefSchema>;

/**
 * The smaller of two optional limits; null when neither sets one.
 *
 * Every numeric limit a profile carries is combined this way, which is what
 * makes "a profile only narrows" true by construction rather than by care.
 */
export function stricterLimit(a: number | null | undefined, b: number | null | undefined) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/**
 * The domains a run under a profile may use: the profile's list plus the ones
 * every run keeps and the ones this kind of run needs. Null when the profile
 * names none, which means every domain.
 */
export function allowedToolDomains(
  profileDomains: readonly ToolDomain[] | null,
  required: readonly ToolDomain[],
): ToolDomain[] | null {
  if (profileDomains === null) return null;
  const allowed = new Set<ToolDomain>([
    ...PROFILE_ALWAYS_ALLOWED_DOMAINS,
    ...profileDomains,
    ...required,
  ]);
  return TOOL_DOMAINS.filter((domain) => allowed.has(domain));
}
