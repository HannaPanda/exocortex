import {
  effectiveWorkflowLimits,
  QUEUE_NAMES,
  type Settings,
  type WorkflowGraph,
  type WorkflowJob,
  type WorkflowNodeExecutionState,
  type WorkflowNodeExecutionStatus,
  type WorkflowRunLimits,
  workflowRunLimitsSchema,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { createCorrelationId, type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { DEFAULT_NODE_HANDLERS, type NodeHandler, type NodeHandlerRegistry } from './handlers';

/**
 * What the halves of the workflow runtime share (issue #161, ADR-076): the
 * dependencies, the rows they read, and how a job is queued once the
 * transaction that decided on it has committed.
 */

export interface WorkflowRuntimeDependencies {
  prisma: PrismaClient;
  queues: Pick<QueueRegistry, 'enqueue'>;
  settings: (workspaceId: string) => Promise<Settings>;
  logger: Logger;
  handlers?: NodeHandlerRegistry;
  now?: () => Date;
}

/** An attempt in flight, as `workflowProgress` and the limits see it. */
export const ACTIVE_STATUSES: readonly string[] = ['QUEUED', 'RUNNING', 'WAITING'];

export const EXECUTION_SELECT = {
  id: true,
  nodeId: true,
  nodeType: true,
  attempt: true,
  status: true,
  firedHandles: true,
  output: true,
  waitingOn: true,
  errorCode: true,
  errorMessage: true,
  queuedAt: true,
  startedAt: true,
} satisfies Prisma.WorkflowNodeExecutionSelect;

export type ExecutionRow = Prisma.WorkflowNodeExecutionGetPayload<{
  select: typeof EXECUTION_SELECT;
}>;

export const RUN_SELECT = {
  id: true,
  workflowId: true,
  workspaceId: true,
  status: true,
  triggerNodeId: true,
  input: true,
  correlationId: true,
  startedById: true,
  chainDepth: true,
  spentMicroUsd: true,
  nodeExecutionCount: true,
  limits: true,
  deadlineAt: true,
  waitingSince: true,
  workflowVersion: { select: { graph: true } },
} satisfies Prisma.WorkflowRunSelect;

export type RunRow = Prisma.WorkflowRunGetPayload<{ select: typeof RUN_SELECT }>;

export function lower<T extends string>(value: string): T {
  return value.toLowerCase() as T;
}

export function toState(row: ExecutionRow): WorkflowNodeExecutionState {
  return {
    nodeId: row.nodeId,
    attempt: row.attempt,
    status: lower<WorkflowNodeExecutionStatus>(row.status),
    firedHandles: row.firedHandles,
  };
}

export function handlerFor(
  dependencies: WorkflowRuntimeDependencies,
  nodeType: string,
): NodeHandler | undefined {
  const registry = dependencies.handlers ?? DEFAULT_NODE_HANDLERS;
  return (registry as Readonly<Record<string, NodeHandler>>)[nodeType];
}

export function clock(dependencies: WorkflowRuntimeDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

export function runLimits(
  run: RunRow,
  settings: Settings,
  graph: WorkflowGraph,
): WorkflowRunLimits {
  const stored = workflowRunLimitsSchema.safeParse(run.limits);
  return stored.success ? stored.data : effectiveWorkflowLimits(graph.limits, settings);
}

/** What a queued job needs to name; enqueued only after the transaction committed. */
export interface PendingJob {
  job: WorkflowJob;
  delayMs?: number;
  jobId?: string;
}

export async function enqueueAll(
  dependencies: WorkflowRuntimeDependencies,
  jobs: readonly PendingJob[],
): Promise<void> {
  for (const pending of jobs) {
    await dependencies.queues.enqueue(QUEUE_NAMES.workflow, pending.job, {
      ...(pending.jobId === undefined ? {} : { jobId: pending.jobId }),
      ...(pending.delayMs === undefined ? {} : { delay: pending.delayMs }),
    });
  }
}

export function executeJob(
  runId: string,
  executionId: string,
  correlationId: string | null,
): PendingJob {
  return {
    job: {
      kind: 'execute',
      runId,
      executionId,
      correlationId: correlationId ?? createCorrelationId(),
    },
  };
}

export function advanceJob(runId: string, correlationId: string | null): PendingJob {
  return { job: { kind: 'advance', runId, correlationId: correlationId ?? createCorrelationId() } };
}
