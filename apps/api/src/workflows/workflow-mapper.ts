import { createHash } from 'node:crypto';

import {
  type AiWriteMode,
  graphProblems,
  isTriggerNode,
  type WorkflowAuthor,
  type WorkflowErrorClass,
  type WorkflowGraph,
  workflowGraphSchema,
  type WorkflowNodeExecution,
  type WorkflowNodeExecutionStatus,
  type WorkflowRun,
  type WorkflowRunEvent,
  workflowRunEventTypeSchema,
  workflowRunLimitsSchema,
  type WorkflowRunOrigin,
  type WorkflowRunStatus,
  type WorkflowSummary,
  type WorkflowTriggerType,
  type WorkflowVersion,
  workflowWaitSchema,
} from '@exocortex/contracts';
import { type Prisma, type WorkItemParticipantKind } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PARTICIPANT_FROM_PRISMA } from '../work-items/work-item-mapper';

/** The run statuses still in flight, as the database spells them. */
export const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING'] as const;

const ACCOUNT = { select: { id: true, name: true } } as const;

const AUTHOR_SELECT = {
  draftAuthorKind: true,
  draftAuthor: ACCOUNT,
  draftAgentLabel: true,
  draftAiRunId: true,
} as const;

export const WORKFLOW_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  draftGraph: true,
  draftRevision: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  createdBy: ACCOUNT,
  updatedBy: ACCOUNT,
  ...AUTHOR_SELECT,
  draftAuthoredAt: true,
  publishedVersion: {
    select: { id: true, version: true, publishedAt: true, draftRevision: true, graph: true },
  },
  _count: { select: { runs: { where: { status: { in: [...ACTIVE_RUN_STATUSES] } } } } },
} satisfies Prisma.WorkflowSelect;

export type WorkflowRow = Prisma.WorkflowGetPayload<{ select: typeof WORKFLOW_SELECT }>;

export const VERSION_SELECT = {
  id: true,
  workflowId: true,
  version: true,
  graph: true,
  graphHash: true,
  draftRevision: true,
  publishedAt: true,
  publishedBy: ACCOUNT,
  ...AUTHOR_SELECT,
} satisfies Prisma.WorkflowVersionSelect;

export type VersionRow = Prisma.WorkflowVersionGetPayload<{ select: typeof VERSION_SELECT }>;

export const RUN_SELECT = {
  id: true,
  workflowId: true,
  workspaceId: true,
  workflowVersionId: true,
  status: true,
  origin: true,
  triggerNodeId: true,
  input: true,
  correlationId: true,
  spentMicroUsd: true,
  nodeExecutionCount: true,
  limits: true,
  deadlineAt: true,
  chainDepth: true,
  writeMode: true,
  errorCode: true,
  errorMessage: true,
  summary: true,
  endNodeId: true,
  waitingSince: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  startedBy: ACCOUNT,
  workflowVersion: { select: { version: true } },
} satisfies Prisma.WorkflowRunSelect;

export type RunRow = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_SELECT }>;

export type WorkflowRunEventRow = Prisma.WorkflowRunEventGetPayload<Record<string, never>>;

export type NodeExecutionRow = Prisma.WorkflowNodeExecutionGetPayload<{
  select: {
    id: true;
    nodeId: true;
    nodeType: true;
    attempt: true;
    status: true;
    idempotencyKey: true;
    firedHandles: true;
    input: true;
    output: true;
    waitingOn: true;
    errorClass: true;
    errorCode: true;
    errorMessage: true;
    workItemId: true;
    aiRunId: true;
    queuedAt: true;
    startedAt: true;
    finishedAt: true;
  };
}>;

/**
 * A stored graph, read back through the contract. A row that no longer parses
 * is a bug or a hand edit, never something to guess around, so it is an
 * internal error rather than a silently empty graph.
 */
export function storedGraph(value: Prisma.JsonValue): WorkflowGraph {
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success) throw AppError.internal('A stored workflow graph does not parse');
  return parsed.data;
}

/** JSON with sorted keys, so equal graphs hash equally whatever order they were sent in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function graphHash(graph: WorkflowGraph): string {
  return createHash('sha256').update(canonicalJson(graph)).digest('hex');
}

function triggerTypes(graph: WorkflowGraph): WorkflowTriggerType[] {
  const types = new Set<WorkflowTriggerType>();
  for (const node of graph.nodes) if (isTriggerNode(node)) types.add(node.type);
  return [...types];
}

export function toWorkflowSummary(row: WorkflowRow, draftValid?: boolean): WorkflowSummary {
  const draft = storedGraph(row.draftGraph);
  const published = row.publishedVersion;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    draftRevision: row.draftRevision,
    draftValid: draftValid ?? graphProblems(draft).length === 0,
    hasUnpublishedChanges: published === null || published.draftRevision !== row.draftRevision,
    publishedVersion:
      published === null
        ? null
        : {
            id: published.id,
            version: published.version,
            publishedAt: published.publishedAt.toISOString(),
          },
    triggerTypes: triggerTypes(published === null ? draft : storedGraph(published.graph)),
    activeRunCount: row._count.runs,
    draftAuthor: { ...toWorkflowAuthor(row), at: row.draftAuthoredAt.toISOString() },
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWorkflowAuthor(row: {
  draftAuthorKind: WorkItemParticipantKind;
  draftAuthor: { id: string; name: string | null } | null;
  draftAgentLabel: string | null;
  draftAiRunId: string | null;
}): WorkflowAuthor {
  return {
    kind: PARTICIPANT_FROM_PRISMA[row.draftAuthorKind],
    account: row.draftAuthor,
    agentLabel: row.draftAgentLabel,
    aiRunId: row.draftAiRunId,
  };
}

export function toWorkflowVersion(row: VersionRow): WorkflowVersion {
  return {
    id: row.id,
    workflowId: row.workflowId,
    version: row.version,
    graph: storedGraph(row.graph),
    graphHash: row.graphHash,
    draftRevision: row.draftRevision,
    draftAuthor: toWorkflowAuthor(row),
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
  };
}

export function toWorkflowRun(row: RunRow): WorkflowRun {
  const limits = workflowRunLimitsSchema.safeParse(row.limits);
  return {
    id: row.id,
    workflowId: row.workflowId,
    workspaceId: row.workspaceId,
    workflowVersionId: row.workflowVersionId,
    version: row.workflowVersion.version,
    status: row.status.toLowerCase() as WorkflowRunStatus,
    origin: row.origin.toLowerCase() as WorkflowRunOrigin,
    triggerNodeId: row.triggerNodeId,
    input: row.input,
    correlationId: row.correlationId,
    startedBy: row.startedBy,
    spentMicroUsd: row.spentMicroUsd,
    nodeExecutionCount: row.nodeExecutionCount,
    limits: limits.success ? limits.data : null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    chainDepth: row.chainDepth,
    writeMode: row.writeMode === null ? null : (row.writeMode.toLowerCase() as AiWriteMode),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    summary: row.summary,
    endNodeId: row.endNodeId,
    waitingSince: row.waitingSince?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export function toNodeExecution(row: NodeExecutionRow): WorkflowNodeExecution {
  const wait = workflowWaitSchema.safeParse(row.waitingOn);
  return {
    id: row.id,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    attempt: row.attempt,
    status: row.status.toLowerCase() as WorkflowNodeExecutionStatus,
    idempotencyKey: row.idempotencyKey,
    firedHandles: row.firedHandles,
    input: row.input,
    output: row.output,
    waitingOn: wait.success ? wait.data : null,
    errorClass:
      row.errorClass === null ? null : (row.errorClass.toLowerCase() as WorkflowErrorClass),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    workItemId: row.workItemId,
    aiRunId: row.aiRunId,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * One history row as the wire spells it, or null for a type this build does
 * not know (written by a newer worker during a deploy): left out rather than
 * renamed into something it was not.
 */
export function toRunEvent(row: WorkflowRunEventRow): WorkflowRunEvent | null {
  const type = workflowRunEventTypeSchema.safeParse(row.type);
  if (!type.success) return null;
  const detail = row.detail;
  return {
    sequence: row.sequence,
    type: type.data,
    nodeId: row.nodeId,
    executionId: row.executionId,
    attempt: row.attempt,
    detail:
      typeof detail === 'object' && detail !== null && !Array.isArray(detail)
        ? (detail as Record<string, unknown>)
        : null,
    at: row.at.toISOString(),
  };
}
