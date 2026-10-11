import {
  effectiveWorkflowLimits,
  isTriggerNode,
  nextWorkflowScheduleRun,
  WORKFLOW_RUN_TERMINAL_STATUSES,
  type WorkflowGraph,
  workflowGraphSchema,
  type WorkflowLimitSettings,
  type WorkflowRunEventType,
  type WorkflowRunOrigin,
  type WorkflowRunStatus,
  type WorkflowTriggerType,
} from '@exocortex/contracts';

import { type Prisma, type PrismaClient, type PrismaTransactionClient } from './client';

/**
 * The persisted half of the workflow runtime (issue #161, ADR-076), shared by
 * the API (starting by hand, cancelling, publishing) and the worker (starting
 * by schedule or change, executing).
 *
 * Every write that moves a run takes the run's row lock first, with
 * `lockWorkflowRun`, and writes its history events in the same transaction,
 * so the history is in the order things happened and never names a step that
 * rolled back.
 */

type Db = PrismaClient | PrismaTransactionClient;

/** The run statuses as the database spells them. */
export type WorkflowRunStatusRow = Uppercase<WorkflowRunStatus>;

export const WORKFLOW_RUN_TERMINAL_ROWS = WORKFLOW_RUN_TERMINAL_STATUSES.map(
  (status) => status.toUpperCase() as WorkflowRunStatusRow,
);

/** `<runId>:<nodeId>:<attempt>`: what a node's side effect is keyed by. */
export function workflowIdempotencyKey(runId: string, nodeId: string, attempt: number): string {
  return `${runId}:${nodeId}:${String(attempt)}`;
}

/** The graph of a stored version, or null when the row no longer parses. */
export function parseStoredWorkflowGraph(value: unknown): WorkflowGraph | null {
  const parsed = workflowGraphSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Takes the run's row lock for the rest of the transaction and stamps
 * `advancedAt`. Returns false when the run does not exist. An UPDATE is the
 * lock: a second writer of the same run waits here until the first commits,
 * and then reads what it wrote.
 */
export async function lockWorkflowRun(
  tx: PrismaTransactionClient,
  runId: string,
  now: Date,
): Promise<boolean> {
  const locked = await tx.workflowRun.updateMany({
    where: { id: runId },
    data: { advancedAt: now },
  });
  return locked.count === 1;
}

export interface WorkflowRunEventInput {
  type: WorkflowRunEventType;
  nodeId?: string | null;
  executionId?: string | null;
  attempt?: number | null;
  /** Ids, handles, durations, error classes. Never content. */
  detail?: Record<string, unknown> | null;
  at?: Date;
}

/** Appends history events in order. Call it holding the run's lock. */
export async function appendWorkflowRunEvents(
  tx: PrismaTransactionClient,
  runId: string,
  events: readonly WorkflowRunEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  const run = await tx.workflowRun.update({
    where: { id: runId },
    data: { eventCount: { increment: events.length } },
    select: { eventCount: true },
  });
  const first = run.eventCount - events.length + 1;
  await tx.workflowRunEvent.createMany({
    data: events.map((event, index) => ({
      runId,
      sequence: first + index,
      type: event.type,
      nodeId: event.nodeId ?? null,
      executionId: event.executionId ?? null,
      attempt: event.attempt ?? null,
      ...(event.detail === undefined || event.detail === null
        ? {}
        : { detail: event.detail as Prisma.InputJsonObject }),
      ...(event.at === undefined ? {} : { at: event.at }),
    })),
  });
}

/** Which trigger type a run of each origin starts from; a test may start from any. */
const ORIGIN_TRIGGER: Readonly<Record<WorkflowRunOrigin, WorkflowTriggerType | null>> = {
  manual: 'trigger.manual',
  schedule: 'trigger.schedule',
  event: 'trigger.event',
  test: null,
};

export type StartWorkflowRunRefusal =
  | 'not_found'
  | 'not_published'
  | 'not_enabled'
  | 'version_moved'
  | 'trigger_invalid'
  | 'trigger_ambiguous';

export type StartWorkflowRunResult =
  { ok: true; runId: string } | { ok: false; reason: StartWorkflowRunRefusal };

export interface StartWorkflowRunInput {
  workflowId: string;
  origin: WorkflowRunOrigin;
  /** Null: the published version's only manual trigger. */
  triggerNodeId: string | null;
  input?: Prisma.InputJsonValue;
  /** Who the run acts as: the person who pressed start, or who switched it on. */
  startedById: string | null;
  correlationId: string | null;
  /** How many automations or workflows deep the change that starts it was. */
  chainDepth: number;
  /** The workspace's resolved settings; the run's limits are frozen from them. */
  settings: WorkflowLimitSettings;
  /** A run that starts by itself needs the workflow switched on. */
  requireEnabled: boolean;
  /** The version a trigger row was built from; refused when it has moved on. */
  expectedVersionId?: string;
  now?: Date;
}

/**
 * Starts a run of the published version: the run with its frozen limits, its
 * trigger's execution (succeeded, having taken `next`) and the first history
 * events, in one transaction, so the run is never visible without the step
 * that began it. Executing it is the worker's: the caller enqueues an
 * `advance`, and the sweep catches a run whose enqueue was lost.
 */
export async function startWorkflowRun(
  prisma: PrismaClient,
  input: StartWorkflowRunInput,
): Promise<StartWorkflowRunResult> {
  const now = input.now ?? new Date();
  const workflow = await prisma.workflow.findUnique({
    where: { id: input.workflowId },
    select: {
      workspaceId: true,
      enabled: true,
      publishedVersion: { select: { id: true, graph: true } },
    },
  });
  if (workflow === null) return { ok: false, reason: 'not_found' };
  const version = workflow.publishedVersion;
  if (version === null) return { ok: false, reason: 'not_published' };
  if (input.requireEnabled && !workflow.enabled) return { ok: false, reason: 'not_enabled' };
  if (input.expectedVersionId !== undefined && input.expectedVersionId !== version.id) {
    return { ok: false, reason: 'version_moved' };
  }
  const graph = parseStoredWorkflowGraph(version.graph);
  if (graph === null) return { ok: false, reason: 'trigger_invalid' };

  const expected = ORIGIN_TRIGGER[input.origin];
  let triggerId = input.triggerNodeId;
  if (triggerId === null) {
    const manual = graph.nodes.filter((node) => node.type === 'trigger.manual');
    if (manual.length !== 1) return { ok: false, reason: 'trigger_ambiguous' };
    triggerId = manual[0]!.id;
  }
  const trigger = graph.nodes.find((node) => node.id === triggerId);
  if (
    trigger === undefined ||
    !isTriggerNode(trigger) ||
    (expected !== null && trigger.type !== expected)
  ) {
    return { ok: false, reason: 'trigger_invalid' };
  }

  const limits = effectiveWorkflowLimits(graph.limits, input.settings);
  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.workflowRun.create({
      data: {
        workflowId: input.workflowId,
        workspaceId: workflow.workspaceId,
        workflowVersionId: version.id,
        status: 'QUEUED',
        origin: input.origin.toUpperCase() as Uppercase<WorkflowRunOrigin>,
        triggerNodeId: trigger.id,
        ...(input.input === undefined ? {} : { input: input.input }),
        startedById: input.startedById,
        correlationId: input.correlationId,
        nodeExecutionCount: 1,
        limits: limits as Prisma.InputJsonObject,
        deadlineAt: new Date(now.getTime() + limits.maxLifetimeSeconds * 1_000),
        chainDepth: input.chainDepth,
        createdAt: now,
        startedAt: now,
        advancedAt: now,
      },
      select: { id: true },
    });
    const execution = await tx.workflowNodeExecution.create({
      data: {
        runId: run.id,
        nodeId: trigger.id,
        nodeType: trigger.type,
        attempt: 1,
        status: 'SUCCEEDED',
        idempotencyKey: workflowIdempotencyKey(run.id, trigger.id, 1),
        firedHandles: ['next'],
        ...(input.input === undefined ? {} : { input: input.input }),
        queuedAt: now,
        startedAt: now,
        finishedAt: now,
        availableAt: now,
      },
      select: { id: true },
    });
    await appendWorkflowRunEvents(tx, run.id, [
      {
        type: 'run.started',
        nodeId: trigger.id,
        detail: { origin: input.origin, versionId: version.id, chainDepth: input.chainDepth },
        at: now,
      },
      {
        type: 'node.succeeded',
        nodeId: trigger.id,
        executionId: execution.id,
        attempt: 1,
        detail: { nodeType: trigger.type, handles: ['next'], durationMs: 0 },
        at: now,
      },
      // The path starts at the trigger, so its edges are part of the history.
      ...graph.edges
        .filter((edge) => edge.source.nodeId === trigger.id && edge.source.handle === 'next')
        .map((edge) => ({
          type: 'edge.taken' as const,
          nodeId: edge.target.nodeId,
          detail: { edgeId: edge.id, from: trigger.id, handle: 'next' },
          at: now,
        })),
    ]);
    return run.id;
  });
  return { ok: true, runId };
}

export type CancelWorkflowRunResult =
  | { ok: true; obsoleteAttentionItemIds: string[] }
  | { ok: false; reason: 'not_found' | 'already_finished' };

/**
 * Settles the open approvals of node attempts that ended without an answer
 * (issue #163): the run was cancelled, timed out, or ended at another node.
 * Obsolete, never resolved, because nobody decided anything; the item stays
 * as the record that the question was asked. Returns the settled items with
 * their workspace, so the caller can tell the inboxes.
 */
export async function obsoleteWorkflowApprovals(
  tx: PrismaTransactionClient,
  executionIds: readonly string[],
  now: Date,
): Promise<{ id: string; workspaceId: string }[]> {
  if (executionIds.length === 0) return [];
  return tx.attentionItem.updateManyAndReturn({
    where: { workflowExecutionId: { in: [...executionIds] }, status: 'OPEN' },
    data: {
      status: 'OBSOLETE',
      settledAt: now,
      resolution: { reason: 'workflow_ended' } satisfies Prisma.InputJsonObject,
    },
    select: { id: true, workspaceId: true },
  });
}

/**
 * Cancels a run: the run and everything queued, running or waiting in it
 * become CANCELLED in one transaction. A step that is running right now loses
 * its lease token with it, so whatever it finishes with is discarded rather
 * than recorded on a run that has ended.
 */
export async function cancelWorkflowRun(
  prisma: PrismaClient,
  input: { runId: string; reason: string | null; byUserId: string | null; now?: Date },
): Promise<CancelWorkflowRunResult> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    if (!(await lockWorkflowRun(tx, input.runId, now))) return { ok: false, reason: 'not_found' };
    const run = await tx.workflowRun.findUniqueOrThrow({
      where: { id: input.runId },
      select: { status: true },
    });
    if (WORKFLOW_RUN_TERMINAL_ROWS.includes(run.status)) {
      return { ok: false, reason: 'already_finished' };
    }
    const open = await tx.workflowNodeExecution.findMany({
      where: { runId: input.runId, status: { in: ['QUEUED', 'RUNNING', 'WAITING'] } },
      select: { id: true, nodeId: true, attempt: true },
    });
    await tx.workflowNodeExecution.updateMany({
      where: { id: { in: open.map((row) => row.id) } },
      data: {
        status: 'CANCELLED',
        errorClass: 'CANCELLED',
        errorCode: 'workflow_cancelled',
        leaseToken: null,
        leaseExpiresAt: null,
        wakeAt: null,
        finishedAt: now,
      },
    });
    await tx.workflowRun.update({
      where: { id: input.runId },
      data: {
        status: 'CANCELLED',
        errorCode: 'workflow_cancelled',
        errorMessage: input.reason,
        waitingSince: null,
        finishedAt: now,
      },
    });
    await appendWorkflowRunEvents(tx, input.runId, [
      ...open.map((row) => ({
        type: 'node.cancelled' as const,
        nodeId: row.nodeId,
        executionId: row.id,
        attempt: row.attempt,
        at: now,
      })),
      { type: 'run.cancelled', detail: { byUserId: input.byUserId }, at: now },
    ]);
    const settled = await obsoleteWorkflowApprovals(
      tx,
      open.map((row) => row.id),
      now,
    );
    return { ok: true, obsoleteAttentionItemIds: settled.map((item) => item.id) };
  });
}

/**
 * Rebuilds the trigger projection of one workflow (issue #161): a row per
 * schedule and event trigger of its published version while it is switched
 * on, none otherwise. Called in the transaction that publishes or switches,
 * so the projection never disagrees with the workflow it was read from.
 *
 * A schedule's `nextRunAt` is computed from now, so republishing an unchanged
 * daily schedule keeps the same next slot, and a one-off whose moment has
 * passed gets none.
 */
export async function syncWorkflowTriggers(
  tx: Db,
  workflowId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.workflowTrigger.deleteMany({ where: { workflowId } });
  const workflow = await tx.workflow.findUnique({
    where: { id: workflowId },
    select: {
      workspaceId: true,
      enabled: true,
      publishedVersion: { select: { id: true, graph: true } },
    },
  });
  if (workflow === null || !workflow.enabled || workflow.publishedVersion === null) return;
  const graph = parseStoredWorkflowGraph(workflow.publishedVersion.graph);
  if (graph === null) return;
  const rows: Prisma.WorkflowTriggerCreateManyInput[] = [];
  for (const node of graph.nodes) {
    const base = {
      workflowId,
      workspaceId: workflow.workspaceId,
      workflowVersionId: workflow.publishedVersion.id,
      nodeId: node.id,
      nodeType: node.type,
    };
    if (node.type === 'trigger.schedule') {
      rows.push({ ...base, nextRunAt: nextWorkflowScheduleRun(node.schedule, now) });
    } else if (node.type === 'trigger.event') {
      rows.push({ ...base, events: node.events, scopeDocumentId: node.scopeDocumentId });
    }
  }
  if (rows.length > 0) await tx.workflowTrigger.createMany({ data: rows });
}
