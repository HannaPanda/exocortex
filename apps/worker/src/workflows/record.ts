import {
  WORKFLOW_DEFAULT_MAX_ATTEMPTS,
  type WorkflowErrorClass,
  workflowRetryDelayMs,
  workflowRunLimitsSchema,
} from '@exocortex/contracts';
import {
  appendWorkflowRunEvents,
  lockWorkflowRun,
  type Prisma,
  type PrismaTransactionClient,
  workflowIdempotencyKey,
  type WorkflowRunEventInput,
} from '@exocortex/database';

import {
  type NodeContext,
  type NodeHandler,
  type NodeOutcome,
  type WorkflowWake,
} from './handlers';
import {
  advanceJob,
  clock,
  enqueueAll,
  executeJob,
  EXECUTION_SELECT,
  type ExecutionRow,
  type PendingJob,
  type WorkflowRuntimeDependencies,
} from './shared';

/**
 * Recording what a node's handler answered (issue #161, ADR-076): written
 * only while the attempt is still `RUNNING` under the lease this worker
 * took, in one transaction with its history events and, for a `retryable`
 * failure of an idempotent handler, the next attempt.
 */

/** A claimed attempt: what its handler is given, and the lease it runs under. */
export interface Claim {
  executionId: string;
  leaseToken: string;
  context: Omit<NodeContext, 'logger'>;
  handler: NodeHandler;
  /** The node waited and is being woken; `resume` is called instead of `execute`. */
  wake: WorkflowWake | null;
}

interface Recording {
  tx: PrismaTransactionClient;
  claimed: Claim;
  execution: ExecutionRow;
  now: Date;
  base: Pick<WorkflowRunEventInput, 'nodeId' | 'executionId' | 'attempt' | 'at'>;
  durationMs: number;
}

const RELEASED = { leaseToken: null, leaseExpiresAt: null };

/**
 * Records a handler's outcome, if the lease is still this worker's. A result
 * that arrives after the run was cancelled, or after the sweep gave the
 * attempt to somebody else, is dropped; the history already says why.
 */
export async function recordOutcome(
  dependencies: WorkflowRuntimeDependencies,
  claimed: Claim,
  outcome: NodeOutcome,
): Promise<void> {
  const now = clock(dependencies);
  const runId = claimed.context.run.id;
  const jobs = await dependencies.prisma.$transaction(async (tx): Promise<PendingJob[]> => {
    if (!(await lockWorkflowRun(tx, runId, now))) return [];
    const execution = await tx.workflowNodeExecution.findUnique({
      where: { id: claimed.executionId },
      select: { ...EXECUTION_SELECT, leaseToken: true },
    });
    if (execution?.status !== 'RUNNING' || execution.leaseToken !== claimed.leaseToken) {
      dependencies.logger.info('A workflow node result arrived without its lease and was dropped', {
        workflowRunId: runId,
        executionId: claimed.executionId,
      });
      return [];
    }
    const recording: Recording = {
      tx,
      claimed,
      execution,
      now,
      base: {
        nodeId: execution.nodeId,
        executionId: execution.id,
        attempt: execution.attempt,
        at: now,
      },
      durationMs: now.getTime() - (execution.startedAt ?? now).getTime(),
    };
    const advance = advanceJob(runId, claimed.context.run.correlationId);
    switch (outcome.status) {
      case 'succeeded':
        await recordSuccess(recording, outcome);
        return [advance];
      case 'waiting':
        await recordWaiting(recording, outcome);
        return [advance];
      case 'failed':
        return [advance, ...(await recordFailure(recording, outcome))];
    }
  });
  await enqueueAll(dependencies, jobs);
}

async function recordSuccess(
  recording: Recording,
  outcome: Extract<NodeOutcome, { status: 'succeeded' }>,
): Promise<void> {
  const { tx, claimed, execution, now } = recording;
  await tx.workflowNodeExecution.update({
    where: { id: execution.id },
    data: {
      ...RELEASED,
      status: 'SUCCEEDED',
      firedHandles: outcome.handles,
      ...(outcome.output === undefined || outcome.output === null
        ? {}
        : { output: outcome.output as Prisma.InputJsonObject }),
      ...(outcome.workItemId === undefined ? {} : { workItemId: outcome.workItemId }),
      ...(outcome.aiRunId === undefined ? {} : { aiRunId: outcome.aiRunId }),
      wakeAt: null,
      finishedAt: now,
    },
  });
  const edges = claimed.context.graph.edges.filter(
    (edge) =>
      edge.source.nodeId === execution.nodeId && outcome.handles.includes(edge.source.handle),
  );
  await appendWorkflowRunEvents(tx, claimed.context.run.id, [
    {
      ...recording.base,
      type: 'node.succeeded',
      detail: {
        nodeType: execution.nodeType,
        handles: outcome.handles,
        durationMs: recording.durationMs,
        workItemId: outcome.workItemId ?? null,
        aiRunId: outcome.aiRunId ?? null,
      },
    },
    ...edges.map((edge) => ({
      type: 'edge.taken' as const,
      nodeId: edge.target.nodeId,
      detail: { edgeId: edge.id, from: edge.source.nodeId, handle: edge.source.handle },
      at: now,
    })),
  ]);
}

async function recordWaiting(
  recording: Recording,
  outcome: Extract<NodeOutcome, { status: 'waiting' }>,
): Promise<void> {
  const { tx, execution } = recording;
  const wait = outcome.wait;
  await tx.workflowNodeExecution.update({
    where: { id: execution.id },
    data: {
      ...RELEASED,
      status: 'WAITING',
      waitingOn: wait as Prisma.InputJsonObject,
      wakeAt: wait.kind === 'timer' ? new Date(wait.until) : null,
      ...(outcome.workItemId === undefined ? {} : { workItemId: outcome.workItemId }),
      ...(outcome.aiRunId === undefined ? {} : { aiRunId: outcome.aiRunId }),
    },
  });
  await appendWorkflowRunEvents(tx, recording.claimed.context.run.id, [
    {
      ...recording.base,
      type: 'node.waiting',
      detail: {
        wait: wait.kind,
        workItemId: wait.kind === 'work_item' ? wait.workItemId : null,
        attentionItemId: wait.kind === 'attention_item' ? wait.attentionItemId : null,
        until: wait.kind === 'timer' ? wait.until : null,
      },
    },
  ]);
}

/** Records the failure and, when it may be retried, queues the next attempt. */
async function recordFailure(
  recording: Recording,
  outcome: Extract<NodeOutcome, { status: 'failed' }>,
): Promise<PendingJob[]> {
  const { tx, claimed, execution, now } = recording;
  const runId = claimed.context.run.id;
  await tx.workflowNodeExecution.update({
    where: { id: execution.id },
    data: {
      ...RELEASED,
      status: outcome.errorClass === 'timeout' ? 'TIMED_OUT' : 'FAILED',
      errorClass: outcome.errorClass.toUpperCase() as Uppercase<WorkflowErrorClass>,
      errorCode: outcome.code.slice(0, 100),
      errorMessage: outcome.message.slice(0, 500),
      wakeAt: null,
      finishedAt: now,
    },
  });
  const events: WorkflowRunEventInput[] = [
    {
      ...recording.base,
      type: 'node.failed',
      detail: {
        errorClass: outcome.errorClass,
        errorCode: outcome.code,
        durationMs: recording.durationMs,
      },
    },
  ];
  const retry = await scheduleRetry(recording, outcome.errorClass);
  const jobs: PendingJob[] = [];
  if (retry !== null) {
    events.push({
      type: 'node.retry_scheduled',
      nodeId: execution.nodeId,
      executionId: retry.executionId,
      attempt: execution.attempt + 1,
      detail: { delayMs: retry.delayMs },
      at: now,
    });
    jobs.push({
      ...executeJob(runId, retry.executionId, claimed.context.run.correlationId),
      delayMs: retry.delayMs,
    });
  }
  await appendWorkflowRunEvents(tx, runId, events);
  return jobs;
}

/**
 * The next attempt of a `retryable` failure, queued in the same transaction
 * that recorded the failure, so `workflowProgress` never sees the node as
 * finished in between. Bounded by the handler's attempts and the run's node
 * limit; a node that is not idempotent is never retried.
 */
async function scheduleRetry(
  recording: Recording,
  errorClass: WorkflowErrorClass,
): Promise<{ executionId: string; delayMs: number } | null> {
  const { tx, claimed, execution, now } = recording;
  if (errorClass !== 'retryable' || !claimed.handler.idempotent) return null;
  const maxAttempts = claimed.handler.maxAttempts ?? WORKFLOW_DEFAULT_MAX_ATTEMPTS;
  if (execution.attempt >= maxAttempts) return null;
  const runId = claimed.context.run.id;
  const run = await tx.workflowRun.findUniqueOrThrow({
    where: { id: runId },
    select: { nodeExecutionCount: true, limits: true },
  });
  const limits = workflowRunLimitsSchema.safeParse(run.limits);
  if (limits.success && run.nodeExecutionCount + 1 > limits.data.maxNodeExecutions) return null;

  const attempt = execution.attempt + 1;
  const delayMs = workflowRetryDelayMs(execution.attempt);
  const created = await tx.workflowNodeExecution.create({
    data: {
      runId,
      nodeId: execution.nodeId,
      nodeType: execution.nodeType,
      attempt,
      status: 'QUEUED',
      idempotencyKey: workflowIdempotencyKey(runId, execution.nodeId, attempt),
      queuedAt: now,
      availableAt: new Date(now.getTime() + delayMs),
    },
    select: { id: true },
  });
  await tx.workflowRun.update({
    where: { id: runId },
    data: { nodeExecutionCount: { increment: 1 } },
  });
  return { executionId: created.id, delayMs };
}
