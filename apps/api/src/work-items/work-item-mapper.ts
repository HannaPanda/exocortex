import {
  type WorkItemCriterion,
  workItemCriterionSchema,
  type WorkItemDetail,
  type WorkItemEvent,
  type WorkItemEventData,
  workItemEventDataSchema,
  type WorkItemEventKind,
  type WorkItemParticipant,
  type WorkItemParticipantKind,
  type WorkItemPriority,
  type WorkItemRef,
  type WorkItemRun,
  type WorkItemStatus,
  type WorkItemSummary,
} from '@exocortex/contracts';
import {
  type AiRunStatus as PrismaAiRunStatus,
  type Prisma,
  type WorkItemEventKind as PrismaEventKind,
  type WorkItemParticipantKind as PrismaParticipantKind,
  type WorkItemPriority as PrismaPriority,
  type WorkItemStatus as PrismaStatus,
} from '@exocortex/database';

/**
 * Between the rows and the wire (issue #138).
 *
 * The database speaks in Prisma's upper-case enums, the contract in the
 * lower-case words the issue and every other agent-facing surface use. The
 * maps are total in both directions, so a member added to one side and not
 * the other is a compile error here rather than an `undefined` on the wire.
 */

export const STATUS_TO_PRISMA: Record<WorkItemStatus, PrismaStatus> = {
  queued: 'QUEUED',
  working: 'WORKING',
  blocked: 'BLOCKED',
  waiting_for_human: 'WAITING_FOR_HUMAN',
  review: 'REVIEW',
  done: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};
export const STATUS_FROM_PRISMA: Record<PrismaStatus, WorkItemStatus> = {
  QUEUED: 'queued',
  WORKING: 'working',
  BLOCKED: 'blocked',
  WAITING_FOR_HUMAN: 'waiting_for_human',
  REVIEW: 'review',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const PRIORITY_TO_PRISMA: Record<WorkItemPriority, PrismaPriority> = {
  low: 'LOW',
  normal: 'NORMAL',
  high: 'HIGH',
  urgent: 'URGENT',
};
export const PRIORITY_FROM_PRISMA: Record<PrismaPriority, WorkItemPriority> = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent',
};

export const PARTICIPANT_TO_PRISMA: Record<WorkItemParticipantKind, PrismaParticipantKind> = {
  human: 'HUMAN',
  agent: 'AGENT',
  assistant: 'ASSISTANT',
};
export const PARTICIPANT_FROM_PRISMA: Record<PrismaParticipantKind, WorkItemParticipantKind> = {
  HUMAN: 'human',
  AGENT: 'agent',
  ASSISTANT: 'assistant',
};

export const EVENT_KIND_TO_PRISMA: Record<WorkItemEventKind, PrismaEventKind> = {
  created: 'CREATED',
  updated: 'UPDATED',
  status_changed: 'STATUS_CHANGED',
  assigned: 'ASSIGNED',
  run_started: 'RUN_STARTED',
  result_recorded: 'RESULT_RECORDED',
  note: 'NOTE',
  attention_raised: 'ATTENTION_RAISED',
  attention_resolved: 'ATTENTION_RESOLVED',
  run_resumed: 'RUN_RESUMED',
  resume_failed: 'RESUME_FAILED',
};
const EVENT_KIND_FROM_PRISMA: Record<PrismaEventKind, WorkItemEventKind> = {
  CREATED: 'created',
  UPDATED: 'updated',
  STATUS_CHANGED: 'status_changed',
  ASSIGNED: 'assigned',
  RUN_STARTED: 'run_started',
  RESULT_RECORDED: 'result_recorded',
  NOTE: 'note',
  ATTENTION_RAISED: 'attention_raised',
  ATTENTION_RESOLVED: 'attention_resolved',
  RUN_RESUMED: 'run_resumed',
  RESUME_FAILED: 'resume_failed',
};

const RUN_STATUS_FROM_PRISMA: Record<PrismaAiRunStatus, WorkItemRun['status']> = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
};

const USER_NAME = { select: { id: true, name: true } } as const;

/** What a summary needs from a row, and nothing it does not. */
export const WORK_ITEM_SUMMARY_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  status: true,
  statusReason: true,
  priority: true,
  requesterKind: true,
  requesterId: true,
  requester: USER_NAME,
  assigneeKind: true,
  assigneeId: true,
  assignee: USER_NAME,
  acceptanceCriteria: true,
  dueAt: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  _count: { select: { children: true, runs: true } },
} satisfies Prisma.WorkItemSelect;

export type WorkItemSummaryRow = Prisma.WorkItemGetPayload<{
  select: typeof WORK_ITEM_SUMMARY_SELECT;
}>;

export const WORK_ITEM_DETAIL_SELECT = {
  ...WORK_ITEM_SUMMARY_SELECT,
  goal: true,
  result: true,
  budgetMicroUsd: true,
  parent: { select: { id: true, title: true } },
  refs: {
    select: { role: true, document: { select: { id: true, title: true } } },
    orderBy: { createdAt: 'asc' },
  },
  children: {
    select: WORK_ITEM_SUMMARY_SELECT,
    orderBy: { createdAt: 'asc' },
  },
  runs: {
    select: {
      id: true,
      status: true,
      model: true,
      conversationId: true,
      createdById: true,
      createdAt: true,
      finishedAt: true,
      providerCostMicroUsd: true,
      estimatedCostMicroUsd: true,
      errorCode: true,
    },
    orderBy: { createdAt: 'desc' },
  },
  events: {
    select: {
      id: true,
      kind: true,
      actorKind: true,
      actorId: true,
      actor: USER_NAME,
      agentLabel: true,
      data: true,
      note: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
} satisfies Prisma.WorkItemSelect;

export type WorkItemDetailRow = Prisma.WorkItemGetPayload<{
  select: typeof WORK_ITEM_DETAIL_SELECT;
}>;

/**
 * The stored criteria, read defensively.
 *
 * Written only through the zod schema, so a row that does not parse was
 * edited by hand; an empty list is a truer answer than a 500 for the whole
 * item.
 */
export function parseCriteria(value: Prisma.JsonValue): WorkItemCriterion[] {
  const parsed = workItemCriterionSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function participant(
  kind: PrismaParticipantKind,
  userId: string | null,
  user: { name: string } | null,
): WorkItemParticipant {
  return { kind: PARTICIPANT_FROM_PRISMA[kind], userId, name: user?.name ?? null };
}

export function toWorkItemSummary(row: WorkItemSummaryRow): WorkItemSummary {
  const criteria = parseCriteria(row.acceptanceCriteria);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: STATUS_FROM_PRISMA[row.status],
    statusReason: row.statusReason,
    priority: PRIORITY_FROM_PRISMA[row.priority],
    requester: participant(row.requesterKind, row.requesterId, row.requester),
    assignee:
      row.assigneeKind === null
        ? null
        : participant(row.assigneeKind, row.assigneeId, row.assignee),
    dueAt: row.dueAt?.toISOString() ?? null,
    parentId: row.parentId,
    childCount: row._count.children,
    runCount: row._count.runs,
    criteriaMet: criteria.filter((criterion) => criterion.met).length,
    criteriaTotal: criteria.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** Measured where the provider said, estimated where it did not, unknown otherwise. */
export function runCost(run: {
  providerCostMicroUsd: number | null;
  estimatedCostMicroUsd: number | null;
}): number | null {
  return run.providerCostMicroUsd ?? run.estimatedCostMicroUsd;
}

function toRun(run: WorkItemDetailRow['runs'][number]): WorkItemRun {
  return {
    id: run.id,
    status: RUN_STATUS_FROM_PRISMA[run.status],
    model: run.model,
    conversationId: run.conversationId,
    createdById: run.createdById,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    costMicroUsd: runCost(run),
    errorCode: run.errorCode,
  };
}

function parseEventData(value: Prisma.JsonValue): WorkItemEventData {
  const parsed = workItemEventDataSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function toEvent(event: WorkItemDetailRow['events'][number]): WorkItemEvent {
  return {
    id: event.id,
    kind: EVENT_KIND_FROM_PRISMA[event.kind],
    actor: participant(event.actorKind, event.actorId, event.actor),
    agentLabel: event.agentLabel,
    data: parseEventData(event.data),
    note: event.note,
    createdAt: event.createdAt.toISOString(),
  };
}

function refsOf(row: WorkItemDetailRow, role: 'CONTEXT' | 'RESULT'): WorkItemRef[] {
  return row.refs
    .filter((ref) => ref.role === role)
    .map((ref) => ({ documentId: ref.document.id, title: ref.document.title }));
}

export function toWorkItemDetail(row: WorkItemDetailRow): WorkItemDetail {
  const runs = row.runs.map(toRun);
  return {
    ...toWorkItemSummary(row),
    goal: row.goal,
    acceptanceCriteria: parseCriteria(row.acceptanceCriteria),
    result: row.result,
    budgetMicroUsd: row.budgetMicroUsd,
    spentMicroUsd: runs.reduce((sum, run) => sum + (run.costMicroUsd ?? 0), 0),
    parent: row.parent,
    contextRefs: refsOf(row, 'CONTEXT'),
    resultRefs: refsOf(row, 'RESULT'),
    children: row.children.map(toWorkItemSummary),
    runs,
    events: row.events.map(toEvent),
  };
}
