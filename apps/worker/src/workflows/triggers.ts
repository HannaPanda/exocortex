import {
  AUTOMATION_MAX_DEPTH,
  nextWorkflowScheduleRun,
  QUEUE_NAMES,
  type Settings,
  WORKFLOW_EVENT_DEBOUNCE_MS,
  type WorkflowJob,
} from '@exocortex/contracts';
import {
  parseStoredWorkflowGraph,
  type PrismaClient,
  startWorkflowRun,
  type StartWorkflowRunInput,
} from '@exocortex/database';
import { createCorrelationId, type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import {
  ancestorIds,
  insideEvalSandbox,
  subjectDocumentId,
  triggerForEvent,
} from '../processors/maintenance-tasks/automations';

/**
 * How a workflow starts by itself (issue #161): from a page change, through
 * the outbox like an automation, and from the clock, through the minute
 * sweep. Both read the `workflow_trigger` projection, which only holds rows
 * of workflows that are switched on, and both start the run with
 * `startWorkflowRun`, which checks again that the workflow may.
 *
 * A self-started run acts as the person who switched the workflow on, the
 * way an automation acts as its owner; a workflow nobody switched on (the
 * person was deleted) does not start.
 */

export interface WorkflowTriggerContext {
  prisma: PrismaClient;
  queues: Pick<QueueRegistry, 'enqueue' | 'enqueueDebounced'>;
  settings: (workspaceId: string) => Promise<Settings>;
  logger: Logger;
  now?: () => Date;
}

export interface WorkflowTriggerEvent {
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
  /** The workflow whose node caused this change, when one did. */
  workflowId: string | null;
  /** How many automations or workflows deep the change was. */
  depth: number;
}

/**
 * Queues a debounced start for every event trigger this change matches.
 * Cheap when nothing matches: one indexed query for the workspace's event
 * triggers, after one cached settings read.
 */
export async function startMatchingWorkflows(
  context: WorkflowTriggerContext,
  event: WorkflowTriggerEvent,
): Promise<number> {
  const trigger = triggerForEvent(event.type);
  if (trigger === null) return 0;
  const documentId = subjectDocumentId(event);
  if (documentId === null) return 0;
  if (!(await context.settings(event.workspaceId))['workflows.enabled']) return 0;

  const rows = await context.prisma.workflowTrigger.findMany({
    where: { workspaceId: event.workspaceId, nodeType: 'trigger.event', events: { has: trigger } },
    select: { workflowId: true, nodeId: true, scopeDocumentId: true },
  });
  if (rows.length === 0) return 0;

  const ancestry = await ancestorIds(context.prisma, documentId, event.workspaceId);
  // A copy in an eval sandbox is not a page anybody wrote (ADR-074).
  if (await insideEvalSandbox(context.prisma, documentId, ancestry)) return 0;

  const depth = event.depth + 1;
  let queued = 0;
  for (const row of rows) {
    // A workflow never starts from a change it made itself: the shape people
    // build is "when this page changes, work on it", and without this the
    // work would start the workflow again for ever.
    if (row.workflowId === event.workflowId) continue;
    if (
      row.scopeDocumentId !== null &&
      row.scopeDocumentId !== documentId &&
      !ancestry.has(row.scopeDocumentId)
    ) {
      continue;
    }
    // Chains through other automations and workflows stop at the same depth.
    if (depth > AUTOMATION_MAX_DEPTH) {
      context.logger.warn('Workflow start stopped at the chain depth limit', {
        workflowId: row.workflowId,
        documentId,
        depth,
        correlationId: event.correlationId,
      });
      continue;
    }
    await context.queues.enqueueDebounced(
      QUEUE_NAMES.workflow,
      {
        kind: 'start-event',
        correlationId: event.correlationId,
        workflowId: row.workflowId,
        workspaceId: event.workspaceId,
        nodeId: row.nodeId,
        documentId,
        trigger,
        depth,
      },
      {
        // Per workflow, trigger and page: two pages changing are two starts.
        jobId: `workflow-${row.workflowId}-${row.nodeId}-${documentId}`,
        delayMs: WORKFLOW_EVENT_DEBOUNCE_MS,
        maxDelayMs: WORKFLOW_EVENT_DEBOUNCE_MS * 2,
      },
    );
    queued += 1;
  }
  return queued;
}

/** What `startWorkflowRun` needs that every self-started run shares. */
async function selfStartInput(
  context: WorkflowTriggerContext,
  input: { workflowId: string; workspaceId: string },
): Promise<Pick<StartWorkflowRunInput, 'startedById' | 'settings'> | null> {
  const settings = await context.settings(input.workspaceId);
  if (!settings['workflows.enabled']) return null;
  const workflow = await context.prisma.workflow.findUnique({
    where: { id: input.workflowId },
    select: { enabledById: true },
  });
  if (workflow?.enabledById == null) return null;
  return { startedById: workflow.enabledById, settings };
}

/** The `start-event` job: the debounce window has passed, so start the run. */
export async function startWorkflowFromEvent(
  context: WorkflowTriggerContext,
  job: Extract<WorkflowJob, { kind: 'start-event' }>,
): Promise<string | null> {
  const shared = await selfStartInput(context, job);
  if (shared === null) return null;
  const started = await startWorkflowRun(context.prisma, {
    ...shared,
    workflowId: job.workflowId,
    origin: 'event',
    triggerNodeId: job.nodeId,
    input: { documentId: job.documentId, trigger: job.trigger },
    correlationId: job.correlationId,
    chainDepth: job.depth,
    requireEnabled: true,
    now: context.now?.() ?? new Date(),
  });
  if (!started.ok) {
    context.logger.info('A workflow event start was refused', {
      workflowId: job.workflowId,
      reason: started.reason,
    });
    return null;
  }
  await context.queues.enqueue(QUEUE_NAMES.workflow, {
    kind: 'advance',
    runId: started.runId,
    correlationId: job.correlationId,
  });
  return started.runId;
}

/** Schedules started per sweep; anything past it is picked up a minute later. */
const SCHEDULE_BATCH = 50;

/**
 * Starts every workflow whose schedule trigger has come due (ADR-038's rule):
 * the row is moved on before the run is started, so a worker that dies in
 * between loses one firing rather than firing every minute until it manages
 * to write, and a deployment that slept catches up once, not per missed slot.
 */
export async function startDueWorkflows(
  context: WorkflowTriggerContext,
  now: Date,
  workspaceId: string | null = null,
): Promise<number> {
  const due = await context.prisma.workflowTrigger.findMany({
    where: {
      nodeType: 'trigger.schedule',
      nextRunAt: { lte: now },
      ...(workspaceId === null ? {} : { workspaceId }),
    },
    select: {
      id: true,
      workflowId: true,
      workspaceId: true,
      workflowVersionId: true,
      nodeId: true,
      nextRunAt: true,
    },
    orderBy: { nextRunAt: 'asc' },
    take: SCHEDULE_BATCH,
  });
  let started = 0;
  for (const row of due) {
    const version = await context.prisma.workflowVersion.findUnique({
      where: { id: row.workflowVersionId },
      select: { graph: true },
    });
    const node = parseStoredWorkflowGraph(version?.graph)?.nodes.find(
      (candidate) => candidate.id === row.nodeId,
    );
    const nextRunAt =
      node?.type === 'trigger.schedule' ? nextWorkflowScheduleRun(node.schedule, now) : null;
    const claimed = await context.prisma.workflowTrigger.updateMany({
      where: { id: row.id, nextRunAt: row.nextRunAt },
      data: { nextRunAt },
    });
    if (claimed.count === 0) continue;

    const shared = await selfStartInput(context, row);
    if (shared === null) continue;
    const correlationId = createCorrelationId();
    const result = await startWorkflowRun(context.prisma, {
      ...shared,
      workflowId: row.workflowId,
      origin: 'schedule',
      triggerNodeId: row.nodeId,
      input: { scheduledFor: row.nextRunAt?.toISOString() ?? now.toISOString() },
      correlationId,
      chainDepth: 0,
      requireEnabled: true,
      expectedVersionId: row.workflowVersionId,
      now,
    });
    if (!result.ok) {
      context.logger.info('A scheduled workflow start was refused', {
        workflowId: row.workflowId,
        reason: result.reason,
      });
      continue;
    }
    await context.queues.enqueue(QUEUE_NAMES.workflow, {
      kind: 'advance',
      runId: result.runId,
      correlationId,
    });
    started += 1;
  }
  return started;
}
