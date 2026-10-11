import {
  type Settings,
  type WorkflowEndOutcome,
  type WorkflowErrorClass,
  type WorkflowGraph,
  type WorkflowProgress,
  workflowProgress,
  type WorkflowRunErrorCode,
  type WorkflowRunLimits,
} from '@exocortex/contracts';
import {
  appendWorkflowRunEvents,
  lockWorkflowRun,
  obsoleteWorkflowApprovals,
  parseStoredWorkflowGraph,
  type PrismaTransactionClient,
  WORKFLOW_RUN_TERMINAL_ROWS,
  workflowIdempotencyKey,
  type WorkflowRunEventInput,
} from '@exocortex/database';
import { createCorrelationId } from '@exocortex/logger';

import {
  ACTIVE_STATUSES,
  clock,
  enqueueAll,
  executeJob,
  EXECUTION_SELECT,
  type ExecutionRow,
  lower,
  type PendingJob,
  RUN_SELECT,
  runLimits,
  type RunRow,
  toState,
  type WorkflowRuntimeDependencies,
} from './shared';

/**
 * Advancing a run (issue #161, ADR-076): under the run's lock, ask
 * `workflowProgress` what may run, record the dead nodes as skipped, queue
 * what the limits allow, and finish the run when nothing more can happen.
 */

export interface AdvanceResult {
  /** The run's status afterwards, or null when the run is gone. */
  status: string | null;
  queued: number;
}

/** How a run ends, and what becomes of whatever is still in flight in it. */
interface Ending {
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  code: WorkflowRunErrorCode | null;
  message: string | null;
  openAs: 'CANCELLED' | 'TIMED_OUT';
  limit?: keyof WorkflowRunLimits;
  /** The end node the run ended at, and what it said (issue #163). */
  endNodeId?: string;
  summary?: string | null;
}

interface Step {
  result: AdvanceResult;
  jobs: PendingJob[];
  /** Approvals the ending made obsolete, to tell the inboxes after commit. */
  settled: { id: string; workspaceId: string }[];
}

/**
 * Moves a run on by one transition. Idempotent: a second call with nothing
 * changed in between queues nothing and writes nothing but `advancedAt`.
 */
export async function advanceWorkflowRun(
  dependencies: WorkflowRuntimeDependencies,
  runId: string,
): Promise<AdvanceResult> {
  const head = await dependencies.prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { workspaceId: true },
  });
  if (head === null) return { status: null, queued: 0 };
  const settings = await dependencies.settings(head.workspaceId);
  const now = clock(dependencies);

  const { result, jobs, settled } = await dependencies.prisma.$transaction(
    async (tx): Promise<Step> => {
      if (!(await lockWorkflowRun(tx, runId, now))) {
        return { result: { status: null, queued: 0 }, jobs: [], settled: [] };
      }
      const run = await tx.workflowRun.findUniqueOrThrow({
        where: { id: runId },
        select: RUN_SELECT,
      });
      if (WORKFLOW_RUN_TERMINAL_ROWS.includes(run.status)) {
        return { result: { status: lower(run.status), queued: 0 }, jobs: [], settled: [] };
      }
      const rows = await tx.workflowNodeExecution.findMany({
        where: { runId },
        select: EXECUTION_SELECT,
        orderBy: [{ queuedAt: 'asc' }, { attempt: 'asc' }],
      });
      const graph = parseStoredWorkflowGraph(run.workflowVersion.graph);
      const stop = stopBeforeProgress({ run, graph, settings, now });
      if (stop !== null || graph === null) {
        const ending = stop ?? unreadable();
        const obsolete = await finishRun(tx, run, rows, now, ending);
        return { result: { status: lower(ending.status), queued: 0 }, jobs: [], settled: obsolete };
      }
      return step(tx, { run, rows, graph, limits: runLimits(run, settings, graph), now });
    },
  );
  await enqueueAll(dependencies, jobs);
  await announceSettled(dependencies, settled);
  return result;
}

/** Tells the inboxes that the approvals a finished run asked are obsolete. */
async function announceSettled(
  dependencies: WorkflowRuntimeDependencies,
  settled: readonly { id: string; workspaceId: string }[],
): Promise<void> {
  const bus = dependencies.bus;
  if (bus === undefined || bus === null || settled.length === 0) return;
  const byWorkspace = new Map<string, string[]>();
  for (const item of settled) {
    byWorkspace.set(item.workspaceId, [...(byWorkspace.get(item.workspaceId) ?? []), item.id]);
  }
  for (const [workspaceId, ids] of byWorkspace) {
    await bus
      .publish({
        type: 'attention.changed',
        workspaceId,
        correlationId: createCorrelationId(),
        emittedAt: new Date().toISOString(),
        payload: { attentionItemIds: ids, action: 'settled' },
      })
      .catch(() => undefined);
  }
}

function unreadable(): Ending {
  return {
    status: 'FAILED',
    code: 'workflow_graph_unreadable',
    message: 'The version this run started on no longer parses',
    openAs: 'CANCELLED',
  };
}

/** Why the run ends before anything else is looked at, or null. */
function stopBeforeProgress(input: {
  run: RunRow;
  graph: WorkflowGraph | null;
  settings: Settings;
  now: Date;
}): Ending | null {
  if (input.graph === null) return unreadable();
  if (!input.settings['workflows.enabled']) {
    return {
      status: 'CANCELLED',
      code: 'workflow_disabled',
      message: 'Workflows were switched off for this workspace',
      openAs: 'CANCELLED',
    };
  }
  if (input.run.deadlineAt !== null && input.run.deadlineAt.getTime() <= input.now.getTime()) {
    return {
      status: 'TIMED_OUT',
      code: 'workflow_lifetime_exceeded',
      message: 'The run outlived its maximum lifetime',
      openAs: 'TIMED_OUT',
      limit: 'maxLifetimeSeconds',
    };
  }
  return null;
}

/** Why the run ends now that its progress is known, or null to go on. */
function stopAfterProgress(input: {
  run: RunRow;
  graph: WorkflowGraph;
  rows: readonly ExecutionRow[];
  progress: WorkflowProgress;
  limits: WorkflowRunLimits;
  queueing: number;
}): Ending | null {
  const ended = endReached(input.graph, input.rows);
  if (ended !== null) return ended;
  if (input.progress.settled) {
    return { ...settledOutcome(input.graph, input.rows), openAs: 'CANCELLED' };
  }
  if (
    input.progress.runnable.length > 0 &&
    input.run.spentMicroUsd >= input.limits.budgetMicroUsd
  ) {
    return {
      status: 'FAILED',
      code: 'workflow_budget_exhausted',
      message: 'The run spent its budget and had more to do',
      openAs: 'CANCELLED',
      limit: 'budgetMicroUsd',
    };
  }
  if (input.run.nodeExecutionCount + input.queueing > input.limits.maxNodeExecutions) {
    return {
      status: 'FAILED',
      code: 'workflow_node_limit',
      message: 'The run reached its limit of node executions',
      openAs: 'CANCELLED',
      limit: 'maxNodeExecutions',
    };
  }
  return null;
}

/** The transition itself, for a run that may go on. */
async function step(
  tx: PrismaTransactionClient,
  input: {
    run: RunRow;
    rows: readonly ExecutionRow[];
    graph: WorkflowGraph;
    limits: WorkflowRunLimits;
    now: Date;
  },
): Promise<Step> {
  const { run, rows, graph, limits, now } = input;
  const progress = workflowProgress(graph, run.triggerNodeId, rows.map(toState));
  const nodeTypes = new Map(graph.nodes.map((node) => [node.id, node.type]));
  // The untaken branch and what hangs off it, recorded rather than left
  // implicit, so the history says why a node never ran.
  const events = await recordAttempts(tx, {
    runId: run.id,
    nodeIds: progress.dead,
    nodeTypes,
    status: 'SKIPPED',
    now,
  });

  const slots = Math.max(0, limits.maxParallelBranches - progress.active.length);
  const toQueue = progress.runnable.slice(0, slots);
  const ending = stopAfterProgress({
    run,
    graph,
    rows,
    progress,
    limits,
    queueing: toQueue.length,
  });
  if (ending !== null) {
    await appendWorkflowRunEvents(tx, run.id, events);
    const obsolete = await finishRun(tx, run, rows, now, ending);
    return { result: { status: lower(ending.status), queued: 0 }, jobs: [], settled: obsolete };
  }

  const queued = await recordAttempts(tx, {
    runId: run.id,
    nodeIds: toQueue,
    nodeTypes,
    status: 'QUEUED',
    now,
  });
  events.push(...queued);
  if (progress.runnable.length > toQueue.length) {
    events.push({
      type: 'run.limit_reached',
      detail: {
        limit: 'maxParallelBranches',
        value: limits.maxParallelBranches,
        held: progress.runnable.slice(toQueue.length),
      },
      at: now,
    });
  }

  // Waiting is the status of a run whose every attempt in flight waits for
  // something outside it; one queued or running attempt makes it running.
  const inFlight = rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
  const allWaiting =
    toQueue.length === 0 &&
    inFlight.length > 0 &&
    inFlight.every((row) => row.status === 'WAITING');
  await tx.workflowRun.update({
    where: { id: run.id },
    data: {
      status: allWaiting ? 'WAITING' : 'RUNNING',
      waitingSince: allWaiting ? (run.waitingSince ?? now) : null,
      nodeExecutionCount: { increment: toQueue.length },
    },
  });
  await appendWorkflowRunEvents(tx, run.id, events);
  return {
    result: { status: allWaiting ? 'waiting' : 'running', queued: toQueue.length },
    jobs: queued.map((event) => executeJob(run.id, event.executionId!, run.correlationId)),
    settled: [],
  };
}

/** First attempts for these nodes, skipped or queued, with their history events. */
async function recordAttempts(
  tx: PrismaTransactionClient,
  input: {
    runId: string;
    nodeIds: readonly string[];
    nodeTypes: ReadonlyMap<string, string>;
    status: 'SKIPPED' | 'QUEUED';
    now: Date;
  },
): Promise<WorkflowRunEventInput[]> {
  const events: WorkflowRunEventInput[] = [];
  for (const nodeId of input.nodeIds) {
    const created = await tx.workflowNodeExecution.create({
      data: {
        runId: input.runId,
        nodeId,
        nodeType: input.nodeTypes.get(nodeId) ?? 'unknown',
        attempt: 1,
        status: input.status,
        idempotencyKey: workflowIdempotencyKey(input.runId, nodeId, 1),
        queuedAt: input.now,
        availableAt: input.now,
        ...(input.status === 'SKIPPED' ? { finishedAt: input.now } : {}),
      },
      select: { id: true },
    });
    events.push({
      type: input.status === 'SKIPPED' ? 'node.skipped' : 'node.queued',
      nodeId,
      executionId: created.id,
      attempt: 1,
      at: input.now,
    });
  }
  return events;
}

function latestRows(rows: readonly ExecutionRow[]): Map<string, ExecutionRow> {
  const latest = new Map<string, ExecutionRow>();
  for (const row of rows) {
    const known = latest.get(row.nodeId);
    if (known === undefined || row.attempt > known.attempt) latest.set(row.nodeId, row);
  }
  return latest;
}

const END_PRECEDENCE: readonly WorkflowEndOutcome[] = ['failed', 'cancelled', 'succeeded'];
const END_STATUS = {
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  succeeded: 'SUCCEEDED',
} as const satisfies Record<WorkflowEndOutcome, Ending['status']>;

/**
 * An end node that has run ends the run at once, with its outcome (issue
 * #163): an explicit end is a decision, not a node that happens to be last,
 * so whatever is still in flight on another branch is cancelled with it.
 * Two ends reached together: failed outranks cancelled outranks succeeded.
 */
function endReached(graph: WorkflowGraph, rows: readonly ExecutionRow[]): Ending | null {
  const latest = latestRows(rows);
  const reached = graph.nodes.flatMap((node) =>
    node.type === 'end' && latest.get(node.id)?.status === 'SUCCEEDED' ? [node] : [],
  );
  if (reached.length === 0) return null;
  const end = [...reached].sort(
    (a, b) => END_PRECEDENCE.indexOf(a.outcome) - END_PRECEDENCE.indexOf(b.outcome),
  )[0]!;
  return {
    status: END_STATUS[end.outcome],
    code: end.outcome === 'succeeded' ? null : 'workflow_end_outcome',
    message:
      end.outcome === 'succeeded'
        ? null
        : (end.summary ?? `End node ${end.id} says ${end.outcome}`),
    openAs: 'CANCELLED',
    endNodeId: end.id,
    summary: end.summary,
  };
}

/**
 * How a run that has nothing more to do and reached no end node ends: a node
 * that failed and stopped its branch fails it, unless a join that waits for
 * any input continued past that branch anyway (issue #163); otherwise the
 * run succeeded.
 */
function settledOutcome(
  graph: WorkflowGraph,
  rows: readonly ExecutionRow[],
): Omit<Ending, 'openAs' | 'status'> & { status: 'SUCCEEDED' | 'FAILED' } {
  const latest = latestRows(rows);
  const failed = [...latest.values()].find(
    (row) =>
      (row.status === 'FAILED' || row.status === 'TIMED_OUT') &&
      !absorbedByAnyJoin(graph, row.nodeId, latest),
  );
  if (failed !== undefined) {
    return {
      status: 'FAILED',
      code: 'workflow_node_failed',
      message: `Node ${failed.nodeId} failed: ${failed.errorCode ?? 'unknown'}`,
    };
  }
  return { status: 'SUCCEEDED', code: null, message: null };
}

/**
 * Whether a failed node's branch led into a join that waits for any input and
 * continued: then the failure is one of the alternatives the graph meant to
 * tolerate, and the run's outcome is what came after the join.
 */
function absorbedByAnyJoin(
  graph: WorkflowGraph,
  nodeId: string,
  latest: ReadonlyMap<string, ExecutionRow>,
): boolean {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const queue = [nodeId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of graph.edges) {
      if (edge.source.nodeId !== id || seen.has(edge.target.nodeId)) continue;
      seen.add(edge.target.nodeId);
      const target = nodes.get(edge.target.nodeId);
      if (
        target?.type === 'join' &&
        target.policy === 'any' &&
        latest.get(target.id)?.status === 'SUCCEEDED'
      ) {
        return true;
      }
      queue.push(edge.target.nodeId);
    }
  }
  return false;
}

/**
 * Ends a run. Whatever is still in flight ends with it (`openAs`), and its
 * lease is taken away, so a step still running somewhere records nothing.
 */
async function finishRun(
  tx: PrismaTransactionClient,
  run: RunRow,
  rows: readonly ExecutionRow[],
  now: Date,
  ending: Ending,
): Promise<{ id: string; workspaceId: string }[]> {
  const open = rows.filter((row) => ACTIVE_STATUSES.includes(row.status));
  const errorClass: WorkflowErrorClass = ending.openAs === 'TIMED_OUT' ? 'timeout' : 'cancelled';
  if (open.length > 0) {
    await tx.workflowNodeExecution.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: {
        status: ending.openAs,
        errorClass: errorClass.toUpperCase() as Uppercase<WorkflowErrorClass>,
        errorCode: ending.code,
        leaseToken: null,
        leaseExpiresAt: null,
        wakeAt: null,
        finishedAt: now,
      },
    });
  }
  await tx.workflowRun.update({
    where: { id: run.id },
    data: {
      status: ending.status,
      errorCode: ending.code,
      errorMessage: ending.message,
      summary: ending.summary ?? null,
      endNodeId: ending.endNodeId ?? null,
      waitingSince: null,
      finishedAt: now,
    },
  });
  await appendWorkflowRunEvents(tx, run.id, [
    ...open.map((row) => ({
      type: ending.openAs === 'TIMED_OUT' ? ('node.failed' as const) : ('node.cancelled' as const),
      nodeId: row.nodeId,
      executionId: row.id,
      attempt: row.attempt,
      detail: ending.openAs === 'TIMED_OUT' ? { errorClass: 'timeout' } : null,
      at: now,
    })),
    ...(ending.limit === undefined
      ? []
      : [{ type: 'run.limit_reached' as const, detail: { limit: ending.limit }, at: now }]),
    {
      type: 'run.finished',
      detail: {
        status: lower(ending.status),
        errorCode: ending.code,
        endNodeId: ending.endNodeId ?? null,
      },
      at: now,
    },
  ]);
  // A question nobody needs answered any more (issue #163).
  return obsoleteWorkflowApprovals(
    tx,
    open.map((row) => row.id),
    now,
  );
}
