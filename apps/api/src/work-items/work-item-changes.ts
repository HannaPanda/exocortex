import {
  isClosedWorkItemStatus,
  type UpdateWorkItemRequest,
  type WorkItemAssigneeInput,
  type WorkItemEventData,
  type WorkItemParticipant,
} from '@exocortex/contracts';
import {
  type Prisma,
  type WorkItemEventKind as PrismaEventKind,
  type WorkItemParticipantKind as PrismaParticipantKind,
  type WorkItemStatus as PrismaStatus,
} from '@exocortex/database';

import {
  PARTICIPANT_TO_PRISMA,
  PRIORITY_TO_PRISMA,
  STATUS_FROM_PRISMA,
  STATUS_TO_PRISMA,
} from './work-item-mapper';

/**
 * What an update changes, and which history lines it owes (issue #138).
 *
 * Pure, so the rules that are easy to get subtly wrong -- when `closedAt`
 * moves, when a status reason is dropped, which change is an assignment and
 * which a result -- are tested without a database. The service validates ids
 * against the workspace first and then applies exactly this plan inside one
 * transaction.
 */

export interface ExistingWorkItem {
  status: PrismaStatus;
  statusReason: string | null;
  assigneeKind: PrismaParticipantKind | null;
  assigneeId: string | null;
  result: string | null;
  closedAt: Date | null;
}

export interface WorkItemEventDraft {
  kind: PrismaEventKind;
  data: WorkItemEventData;
}

export interface WorkItemUpdatePlan {
  data: Prisma.WorkItemUncheckedUpdateInput;
  events: WorkItemEventDraft[];
}

/** The fields that are recorded as a plain `updated` line when they change. */
const PLAIN_FIELDS = [
  'title',
  'goal',
  'priority',
  'acceptanceCriteria',
  'contextDocumentIds',
  'budgetMicroUsd',
  'dueAt',
  'parentId',
] as const satisfies readonly (keyof UpdateWorkItemRequest)[];

export function assigneeColumns(assignee: WorkItemAssigneeInput | null): {
  assigneeKind: PrismaParticipantKind | null;
  assigneeId: string | null;
} {
  if (assignee === null) return { assigneeKind: null, assigneeId: null };
  if (assignee.kind === 'assistant') return { assigneeKind: 'ASSISTANT', assigneeId: null };
  return { assigneeKind: PARTICIPANT_TO_PRISMA[assignee.kind], assigneeId: assignee.userId };
}

/** The assignee as a history line stores it: a snapshot, with the name of that moment. */
export function assigneeSnapshot(
  assignee: WorkItemAssigneeInput | null,
  name: string | null,
): WorkItemParticipant | null {
  if (assignee === null) return null;
  if (assignee.kind === 'assistant') return { kind: 'assistant', userId: null, name: null };
  return { kind: assignee.kind, userId: assignee.userId, name };
}

/** Where `closedAt` goes when the status moves from one value to another. */
export function closedAtFor(
  from: PrismaStatus,
  to: PrismaStatus,
  current: Date | null,
  now: Date,
): Date | null {
  const wasClosed = isClosedWorkItemStatus(STATUS_FROM_PRISMA[from]);
  const isClosed = isClosedWorkItemStatus(STATUS_FROM_PRISMA[to]);
  if (isClosed && !wasClosed) return now;
  if (!isClosed) return null;
  return current;
}

function planStatus(
  existing: ExistingWorkItem,
  request: UpdateWorkItemRequest,
  now: Date,
  plan: WorkItemUpdatePlan,
): boolean {
  const next = request.status === undefined ? existing.status : STATUS_TO_PRISMA[request.status];
  if (next === existing.status) {
    // Only the reason changed: an edit of the explanation, not a transition.
    if (request.statusReason !== undefined && request.statusReason !== existing.statusReason) {
      plan.data.statusReason = request.statusReason;
      return true;
    }
    return false;
  }

  // A transition that brings no reason of its own drops the old one: "waits on
  // the review" must not stay attached to an item that is now done.
  const reason = request.statusReason ?? null;
  plan.data.status = next;
  plan.data.statusReason = reason;
  plan.data.closedAt = closedAtFor(existing.status, next, existing.closedAt, now);
  plan.events.push({
    kind: 'STATUS_CHANGED',
    data: {
      from: STATUS_FROM_PRISMA[existing.status],
      to: STATUS_FROM_PRISMA[next],
      ...(reason === null ? {} : { reason }),
    },
  });
  return false;
}

function planAssignee(
  existing: ExistingWorkItem,
  request: UpdateWorkItemRequest,
  assigneeName: string | null,
  plan: WorkItemUpdatePlan,
): void {
  if (request.assignee === undefined) return;
  const columns = assigneeColumns(request.assignee);
  if (
    columns.assigneeKind === existing.assigneeKind &&
    columns.assigneeId === existing.assigneeId
  ) {
    return;
  }
  plan.data.assigneeKind = columns.assigneeKind;
  plan.data.assigneeId = columns.assigneeId;
  plan.events.push({
    kind: 'ASSIGNED',
    data: { assignee: assigneeSnapshot(request.assignee, assigneeName) },
  });
}

function planResult(
  existing: ExistingWorkItem,
  request: UpdateWorkItemRequest,
  plan: WorkItemUpdatePlan,
): void {
  const fields: string[] = [];
  if (request.result !== undefined && request.result !== existing.result) {
    plan.data.result = request.result;
    fields.push('result');
  }
  if (request.resultDocumentIds !== undefined) fields.push('resultDocumentIds');
  if (fields.length > 0) plan.events.push({ kind: 'RESULT_RECORDED', data: { fields } });
}

function planPlainFields(request: UpdateWorkItemRequest, plan: WorkItemUpdatePlan): string[] {
  const touched = PLAIN_FIELDS.filter((field) => request[field] !== undefined);
  if (request.title !== undefined) plan.data.title = request.title;
  if (request.goal !== undefined) plan.data.goal = request.goal;
  if (request.priority !== undefined) plan.data.priority = PRIORITY_TO_PRISMA[request.priority];
  if (request.acceptanceCriteria !== undefined) {
    plan.data.acceptanceCriteria = request.acceptanceCriteria;
  }
  if (request.budgetMicroUsd !== undefined) plan.data.budgetMicroUsd = request.budgetMicroUsd;
  if (request.dueAt !== undefined) {
    plan.data.dueAt = request.dueAt === null ? null : new Date(request.dueAt);
  }
  if (request.parentId !== undefined) plan.data.parentId = request.parentId;
  return touched;
}

export function planWorkItemUpdate(input: {
  existing: ExistingWorkItem;
  request: UpdateWorkItemRequest;
  /** The new assignee's display name, resolved by the caller while validating it. */
  assigneeName: string | null;
  now: Date;
}): WorkItemUpdatePlan {
  const plan: WorkItemUpdatePlan = { data: {}, events: [] };

  const reasonOnly = planStatus(input.existing, input.request, input.now, plan);
  planAssignee(input.existing, input.request, input.assigneeName, plan);
  planResult(input.existing, input.request, plan);

  const touched = planPlainFields(input.request, plan);
  if (reasonOnly) touched.push('statusReason');
  if (touched.length > 0) plan.events.push({ kind: 'UPDATED', data: { fields: touched } });

  return plan;
}
