import { type WorkflowNodeOf, workflowWaitSchema } from '@exocortex/contracts';
import {
  appendWorkflowRunEvents,
  lockWorkflowRun,
  parseStoredWorkflowGraph,
} from '@exocortex/database';
import { createCorrelationId } from '@exocortex/logger';

import { agentCompletion, loadAgentWork } from './agent-completion';
import {
  advanceJob,
  enqueueAll,
  executeJob,
  handlerFor,
  type PendingJob,
  type WorkflowRuntimeDependencies,
} from './shared';
import { startDueWorkflows, type WorkflowTriggerContext } from './triggers';

/**
 * The workflow runtime's net (issue #161, ADR-076), run every minute.
 *
 * Every step of a run is a job, and a job can be lost: a worker killed with
 * its job in hand, an enqueue that failed after its transaction committed,
 * Redis restarted. None of that may strand a run, so this sweep finds what a
 * lost job left behind in the rows and hands it back:
 *
 * 1. due schedule triggers start their runs;
 * 2. an attempt whose lease expired is recovered: queued again when its
 *    handler is idempotent, failed as interrupted when it is not, and put
 *    back to waiting when it had been woken;
 * 3. a queued attempt that is due and has been for a while is queued again;
 * 4. a waiting attempt whose timer is due is woken;
 * 5. a run that nobody advanced for a while, or whose deadline passed, is
 *    advanced, which also times it out;
 * 6. an agent node waiting on a work item that would settle it now -- the
 *    item closed, handed in, deleted, or stalled with no run left -- is
 *    woken, for the wake the API sends after a change can be lost and a run
 *    ending sends none (issue #162);
 * 7. an approval node whose attention item was answered or became obsolete
 *    is woken, for the same reason (issue #163).
 *
 * A duplicate costs nothing: every job claims or locks before it acts, so a
 * second copy finds the work done.
 */

/** How long a due step may sit before the sweep assumes its job was lost. */
const LOST_AFTER_MS = 2 * 60_000;
/** Rows per kind per sweep. */
const BATCH = 100;
/** How far back the sweep looks for an approval answered without its wake. */
const SETTLED_WINDOW_MS = 24 * 3_600_000;

export async function sweepWorkflowRuns(
  dependencies: WorkflowRuntimeDependencies & {
    triggers: WorkflowTriggerContext;
    /** Only this workspace's runs; null or absent sweeps the deployment. */
    workspaceId?: string | null;
  },
): Promise<Record<string, number>> {
  const now = dependencies.now?.() ?? new Date();
  const scope = dependencies.workspaceId ?? null;
  const inRun = scope === null ? {} : { run: { workspaceId: scope } };
  const inWorkspace = scope === null ? {} : { workspaceId: scope };
  const lostBefore = new Date(now.getTime() - LOST_AFTER_MS);
  // One job id per row per minute: two sweeps of one minute add one job.
  const minute = Math.floor(now.getTime() / 60_000);
  const prisma = dependencies.prisma;
  const jobs: PendingJob[] = [];

  const started = await startDueWorkflows(dependencies.triggers, now, scope);

  const expired = await prisma.workflowNodeExecution.findMany({
    where: { status: 'RUNNING', leaseExpiresAt: { lt: now }, ...inRun },
    select: { id: true },
    take: BATCH,
  });
  let recovered = 0;
  for (const row of expired) {
    const job = await recoverExpiredLease(dependencies, row.id, now);
    if (job !== null) {
      jobs.push(job);
      recovered += 1;
    }
  }

  const stalled = await prisma.workflowNodeExecution.findMany({
    where: { status: 'QUEUED', availableAt: { lt: lostBefore }, ...inRun },
    select: { id: true, runId: true },
    take: BATCH,
  });
  for (const row of stalled) {
    jobs.push({
      ...executeJob(row.runId, row.id, null),
      jobId: `workflow-execute-${row.id}-sweep-${String(minute)}`,
    });
  }

  const timers = await prisma.workflowNodeExecution.findMany({
    where: { status: 'WAITING', wakeAt: { lte: now }, ...inRun },
    select: { id: true, runId: true },
    take: BATCH,
  });
  for (const row of timers) {
    jobs.push({
      job: {
        kind: 'resume',
        runId: row.runId,
        executionId: row.id,
        wake: { kind: 'timer' },
        correlationId: createCorrelationId(),
      },
      jobId: `workflow-resume-${row.id}-${String(minute)}`,
    });
  }

  const runs = await prisma.workflowRun.findMany({
    where: {
      ...inWorkspace,
      OR: [
        { status: { in: ['QUEUED', 'RUNNING'] }, advancedAt: { lt: lostBefore } },
        { status: { in: ['QUEUED', 'RUNNING', 'WAITING'] }, deadlineAt: { lte: now } },
      ],
    },
    select: { id: true },
    take: BATCH,
  });
  for (const row of runs) {
    jobs.push({
      ...advanceJob(row.id, null),
      jobId: `workflow-advance-${row.id}-sweep-${String(minute)}`,
    });
  }

  const settled = await settledAgentNodes(dependencies, inRun, now);
  for (const row of settled) {
    jobs.push({
      job: {
        kind: 'resume',
        runId: row.runId,
        executionId: row.id,
        wake: { kind: 'work_item', workItemId: row.workItemId },
        correlationId: createCorrelationId(),
      },
      jobId: `workflow-resume-${row.id}-${String(minute)}`,
    });
  }

  const answered = await answeredApprovals(dependencies, scope, now);
  for (const row of answered) {
    jobs.push({
      job: {
        kind: 'resume',
        runId: row.runId,
        executionId: row.id,
        wake: { kind: 'attention_item', attentionItemId: row.attentionItemId },
        correlationId: createCorrelationId(),
      },
      jobId: `workflow-resume-${row.id}-${String(minute)}`,
    });
  }

  await enqueueAll(dependencies, jobs);
  return {
    started,
    recovered,
    requeued: stalled.length,
    woken: timers.length + settled.length + answered.length,
    advanced: runs.length,
  };
}

/**
 * Waiting agent nodes whose work item would settle them if they were woken.
 * Asked with the same `agentCompletion` the node's resume uses, so the sweep
 * queues a resume only when the node would move, not one per minute per
 * waiting node.
 */
async function settledAgentNodes(
  dependencies: WorkflowRuntimeDependencies,
  inRun: { run?: { workspaceId: string } },
  now: Date,
): Promise<{ id: string; runId: string; workItemId: string }[]> {
  const waiting = await dependencies.prisma.workflowNodeExecution.findMany({
    where: { status: 'WAITING', nodeType: 'agent', ...inRun },
    select: {
      id: true,
      runId: true,
      nodeId: true,
      waitingOn: true,
      run: { select: { workflowVersion: { select: { graph: true } } } },
    },
    take: BATCH,
  });
  const due: { id: string; runId: string; workItemId: string }[] = [];
  for (const row of waiting) {
    const wait = workflowWaitSchema.safeParse(row.waitingOn);
    if (!wait.success || wait.data.kind !== 'work_item') continue;
    const graph = parseStoredWorkflowGraph(row.run.workflowVersion.graph);
    const node = graph?.nodes.find((candidate) => candidate.id === row.nodeId);
    if (node?.type !== 'agent') continue;
    const work = await loadAgentWork(dependencies.prisma, wait.data.workItemId);
    const decision = agentCompletion(node as WorkflowNodeOf<'agent'>, work, now);
    if (decision.kind !== 'wait') {
      due.push({ id: row.id, runId: row.runId, workItemId: wait.data.workItemId });
    }
  }
  return due;
}

/**
 * Waiting approval nodes whose attention item was settled -- answered, or
 * obsolete -- in the last day (issue #163). Read from the settled items
 * rather than the waiting nodes, so questions that stay open for days never
 * crowd an answered one out of the batch; a day is far more than a net run
 * every minute needs.
 */
async function answeredApprovals(
  dependencies: WorkflowRuntimeDependencies,
  scope: string | null,
  now: Date,
): Promise<{ id: string; runId: string; attentionItemId: string }[]> {
  const settled = await dependencies.prisma.attentionItem.findMany({
    where: {
      workflowExecutionId: { not: null },
      status: { not: 'OPEN' },
      settledAt: { gte: new Date(now.getTime() - SETTLED_WINDOW_MS) },
      ...(scope === null ? {} : { workspaceId: scope }),
    },
    select: { id: true, workflowExecutionId: true },
    orderBy: { settledAt: 'desc' },
    take: BATCH,
  });
  if (settled.length === 0) return [];
  const byExecution = new Map(settled.map((item) => [item.workflowExecutionId!, item.id]));
  const waiting = await dependencies.prisma.workflowNodeExecution.findMany({
    where: { id: { in: [...byExecution.keys()] }, status: 'WAITING' },
    select: { id: true, runId: true },
  });
  return waiting.map((row) => ({
    id: row.id,
    runId: row.runId,
    attentionItemId: byExecution.get(row.id)!,
  }));
}

/**
 * Recovers one attempt whose worker did not come back within its lease.
 * Decided under the run's lock with the lease re-read, so a worker that was
 * merely slow and has just written its result is left alone.
 */
async function recoverExpiredLease(
  dependencies: WorkflowRuntimeDependencies,
  executionId: string,
  now: Date,
): Promise<PendingJob | null> {
  const head = await dependencies.prisma.workflowNodeExecution.findUnique({
    where: { id: executionId },
    select: { runId: true },
  });
  if (head === null) return null;
  return dependencies.prisma.$transaction(async (tx) => {
    if (!(await lockWorkflowRun(tx, head.runId, now))) return null;
    const execution = await tx.workflowNodeExecution.findUniqueOrThrow({
      where: { id: executionId },
      select: {
        id: true,
        nodeId: true,
        nodeType: true,
        attempt: true,
        status: true,
        leaseExpiresAt: true,
        waitingOn: true,
        wakeAt: true,
      },
    });
    if (
      execution.status !== 'RUNNING' ||
      execution.leaseExpiresAt === null ||
      execution.leaseExpiresAt.getTime() >= now.getTime()
    ) {
      return null;
    }
    const handler = handlerFor(dependencies, execution.nodeType);
    const event = {
      type: 'node.recovered' as const,
      nodeId: execution.nodeId,
      executionId: execution.id,
      attempt: execution.attempt,
      at: now,
    };
    const released = { leaseToken: null, leaseExpiresAt: null };

    // It had been woken from a wait: back to waiting, so the wake can come
    // again. A timer whose moment has passed fires on the next sweep.
    const woken = workflowWaitSchema.safeParse(execution.waitingOn);
    if (woken.success) {
      await tx.workflowNodeExecution.update({
        where: { id: execution.id },
        data: {
          ...released,
          status: 'WAITING',
          ...(woken.data.kind === 'timer' ? { wakeAt: execution.wakeAt ?? now } : {}),
        },
      });
      await appendWorkflowRunEvents(tx, head.runId, [
        { ...event, detail: { action: 'waiting_again' } },
      ]);
      return null;
    }

    if (handler?.idempotent === true) {
      await tx.workflowNodeExecution.update({
        where: { id: execution.id },
        data: { ...released, status: 'QUEUED', availableAt: now },
      });
      await appendWorkflowRunEvents(tx, head.runId, [{ ...event, detail: { action: 'requeued' } }]);
      return executeJob(head.runId, execution.id, null);
    }

    // Not safe to run twice: whatever it did may have happened. Failing it is
    // the honest answer, and the run decides from there.
    await tx.workflowNodeExecution.update({
      where: { id: execution.id },
      data: {
        ...released,
        status: 'FAILED',
        errorClass: 'TERMINAL',
        errorCode: 'workflow_node_interrupted',
        errorMessage: 'The worker running this node did not come back before its lease expired',
        finishedAt: now,
      },
    });
    await appendWorkflowRunEvents(tx, head.runId, [{ ...event, detail: { action: 'failed' } }]);
    return advanceJob(head.runId, null);
  });
}
