import {
  type AgentApprovalPolicy,
  AI_WRITE_MODES,
  type AiWriteMode,
  type CreateWorkItemRequest,
  type DelegateWorkRequest,
  strictestWriteMode,
  type ToolDomain,
  toolDomainSchema,
  type WorkItemAssigneeInput,
  type WorkItemChildProgress,
} from '@exocortex/contracts';
import { type WorkItemStatus as PrismaStatus } from '@exocortex/database';

/**
 * The pure rules of delegation (issue #144, ADR-072): what a child may be
 * given, and what its status means to the parent.
 */

/**
 * The statuses in which a child has come back: the parent can act on it.
 * Review counts, because a result waiting for acceptance is exactly what the
 * parent was waiting for; failed and cancelled count, because the parent has
 * to decide what happens next.
 */
const RETURNED: readonly PrismaStatus[] = ['REVIEW', 'DONE', 'FAILED', 'CANCELLED'];

export function hasReturned(status: PrismaStatus): boolean {
  return RETURNED.includes(status);
}

export function childProgressOf(
  children: readonly { status: PrismaStatus }[],
): WorkItemChildProgress {
  const progress: WorkItemChildProgress = {
    total: children.length,
    open: 0,
    waiting: 0,
    review: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const { status } of children) {
    if (status === 'QUEUED' || status === 'WORKING') progress.open += 1;
    else if (status === 'BLOCKED' || status === 'WAITING_FOR_HUMAN') progress.waiting += 1;
    else if (status === 'REVIEW') progress.review += 1;
    else if (status === 'DONE') progress.done += 1;
    else if (status === 'FAILED') progress.failed += 1;
    else progress.cancelled += 1;
  }
  return progress;
}

/**
 * A child's write mode: the stricter of what was asked, the parent's own and
 * what the caller may itself do. Null only when none of the three says
 * anything, so the child inherits the workspace like any other item. A child
 * can therefore never write more than the work it is part of, nor more than
 * the agent that handed it on.
 */
export function childWriteMode(
  requested: AiWriteMode | null,
  parent: AiWriteMode | null,
  callerCeiling: AiWriteMode,
): AiWriteMode | null {
  const ceiling = callerCeiling === 'direct' ? null : callerCeiling;
  const modes = [requested, parent, ceiling];
  if (modes.every((mode) => mode === null)) return null;
  return strictestWriteMode(...modes);
}

export const PROFILE_LIMITS_SELECT = {
  toolDomains: true,
  writeMode: true,
  approvalPolicy: true,
  budgetMicroUsdPerRun: true,
  budgetMicroUsdPerTask: true,
  maxToolIterations: true,
  maxRunSeconds: true,
  confineToWorkspace: true,
} as const;

/** The limits of a profile, as far as "no looser than" is concerned. */
export interface ProfileLimits {
  toolDomains: readonly ToolDomain[] | null;
  writeMode: AiWriteMode;
  approvalPolicy: AgentApprovalPolicy;
  budgetMicroUsdPerRun: number | null;
  budgetMicroUsdPerTask: number | null;
  maxToolIterations: number | null;
  maxRunSeconds: number | null;
  confineToWorkspace: boolean;
}

/** A child's numeric limit is no looser when the parent sets none or it sets one as tight. */
function limitHolds(child: number | null, parent: number | null): boolean {
  return parent === null || (child !== null && child <= parent);
}

/**
 * Whether a profile is at least as strict as the one the parent works under,
 * in every limit it can set.
 *
 * This is what lets an agent pick a role for a child without being able to
 * pick the rules it runs under (ADR-071): handing a part on under a narrower
 * profile only ever takes something away. A parent under no profile at all
 * allows every profile, because a profile only narrows. Model, reasoning and
 * routing are preferences rather than limits, and the budgets bound what a
 * different model can cost.
 */
export function profileNoLooser(child: ProfileLimits, parent: ProfileLimits | null): boolean {
  if (parent === null) return true;
  if (parent.toolDomains !== null) {
    if (child.toolDomains === null) return false;
    const allowed = new Set(parent.toolDomains);
    if (child.toolDomains.some((domain) => !allowed.has(domain))) return false;
  }
  if (AI_WRITE_MODES.indexOf(child.writeMode) > AI_WRITE_MODES.indexOf(parent.writeMode)) {
    return false;
  }
  if (parent.approvalPolicy === 'review_before_done' && child.approvalPolicy === 'none') {
    return false;
  }
  if (parent.confineToWorkspace && !child.confineToWorkspace) return false;
  return (
    limitHolds(child.budgetMicroUsdPerRun, parent.budgetMicroUsdPerRun) &&
    limitHolds(child.budgetMicroUsdPerTask, parent.budgetMicroUsdPerTask) &&
    limitHolds(child.maxToolIterations, parent.maxToolIterations) &&
    limitHolds(child.maxRunSeconds, parent.maxRunSeconds)
  );
}

/**
 * The budget a child gets: what was asked, but never more than the parent
 * has left. Left out, the child may use the whole remainder; the subtree rule
 * in `work-item-budget.ts` holds either way, so this only makes the child's
 * own limit say what is true.
 */
export function childBudget(
  requested: number | undefined,
  remaining: number | null,
): number | null {
  if (remaining === null) return requested ?? null;
  return Math.min(requested ?? remaining, remaining);
}

/** A result cut to a budget at a word boundary, and whether it was cut. */
export function cutText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxChars * 0.8 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()} …`, truncated: true };
}

/**
 * Whether a run may start on a child while its siblings run.
 *
 * Children that cannot write pages (read-only or proposing) may all run at
 * once; a child that writes directly waits while another directly writing
 * sibling has a run in flight, because two runs editing the same area at the
 * same time is the conflict proposals exist to avoid. Null counts as direct,
 * because inheriting may well mean inheriting `direct`.
 */
export function writesDirectly(mode: 'READ_ONLY' | 'PROPOSE' | 'DIRECT' | null): boolean {
  return mode === null || mode === 'DIRECT';
}

/**
 * The ordinary create request a delegation makes: the budget carved, the
 * write mode held, and what the result should look like put first among the
 * criteria, because it is the first thing the result is measured by.
 */
export function childCreateRequest(input: {
  request: DelegateWorkRequest;
  assignee: WorkItemAssigneeInput;
  parent: { id: string; writeMode: 'READ_ONLY' | 'PROPOSE' | 'DIRECT' | null };
  remaining: number | null;
  callerWriteCeiling: AiWriteMode;
}): CreateWorkItemRequest {
  const { request, parent } = input;
  const parentMode =
    parent.writeMode === null ? null : (parent.writeMode.toLowerCase() as AiWriteMode);
  const expected =
    request.expectedResult === undefined ? [] : [{ text: request.expectedResult, met: false }];
  return {
    title: request.title,
    goal: request.goal,
    assignee: input.assignee,
    acceptanceCriteria: [...expected, ...(request.acceptanceCriteria ?? [])],
    budgetMicroUsd: childBudget(request.budgetMicroUsd, input.remaining),
    writeMode: childWriteMode(request.writeMode ?? null, parentMode, input.callerWriteCeiling),
    parentId: parent.id,
    ...pick(request, ['priority', 'contextDocumentIds', 'agentProfileId', 'dueAt']),
  };
}

/** The named fields that are set, and only those. */
function pick<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return picked;
}

/** A profile row as the limits "no looser than" compares. */
export function limitsOf(row: {
  toolDomains: unknown;
  writeMode: 'READ_ONLY' | 'PROPOSE' | 'DIRECT';
  approvalPolicy: 'NONE' | 'REVIEW_BEFORE_DONE';
  budgetMicroUsdPerRun: number | null;
  budgetMicroUsdPerTask: number | null;
  maxToolIterations: number | null;
  maxRunSeconds: number | null;
  confineToWorkspace: boolean;
}): ProfileLimits {
  const domains = toolDomainSchema.array().safeParse(row.toolDomains);
  return {
    // A list that does not parse narrows to nothing rather than opening everything.
    toolDomains: row.toolDomains === null ? null : domains.success ? domains.data : [],
    writeMode: row.writeMode.toLowerCase() as AiWriteMode,
    approvalPolicy: row.approvalPolicy === 'REVIEW_BEFORE_DONE' ? 'review_before_done' : 'none',
    budgetMicroUsdPerRun: row.budgetMicroUsdPerRun,
    budgetMicroUsdPerTask: row.budgetMicroUsdPerTask,
    maxToolIterations: row.maxToolIterations,
    maxRunSeconds: row.maxRunSeconds,
    confineToWorkspace: row.confineToWorkspace,
  };
}
