import { z } from 'zod';

import { stricterLimit } from './agent-profiles';
import { type AutomationSchedule, nextAutomationRun } from './automation-schedule';
import { type WorkflowGraphLimits, type WorkflowSchedule } from './workflow-graph';

/**
 * What the workflow runtime promises (issue #161, ADR-076).
 *
 * A run is persisted state and every transition is written before the next
 * one is scheduled: the limits it runs under are frozen when it starts, a
 * node attempt is claimed with a lease before its handler runs, and what
 * happened is recorded as events of ids, handles, attempts and durations.
 * This file holds the parts a reader outside the worker needs: the limits,
 * the event vocabulary, the error codes a run or an attempt can end with, and
 * the header that marks a write as the work of a workflow.
 */

/**
 * The limits a run executes under, each the stricter of the graph's own and
 * the workspace's setting. Frozen on the run when it starts, so lowering a
 * setting stops new runs early without changing the rules for one in flight
 * mid-step -- except `workflows.enabled`, which stops it at its next step.
 */
export const workflowRunLimitsSchema = z.object({
  maxNodeExecutions: z.number().int().min(1),
  maxParallelBranches: z.number().int().min(1),
  maxLifetimeSeconds: z.number().int().min(1),
  budgetMicroUsd: z.number().int().min(0),
});
export type WorkflowRunLimits = z.infer<typeof workflowRunLimitsSchema>;

/** The workspace settings a run's limits are combined with. */
export interface WorkflowLimitSettings {
  'workflows.maxNodeExecutions': number;
  'workflows.maxParallelBranches': number;
  'workflows.maxLifetimeSeconds': number;
  'workflows.budgetMicroUsdPerRun': number;
}

/**
 * The limits of a run: every graph limit combined with its setting by taking
 * the stricter, so a graph can narrow and never widen. A settings value is
 * always present, so the result has no gaps.
 */
export function effectiveWorkflowLimits(
  graph: WorkflowGraphLimits,
  settings: WorkflowLimitSettings,
): WorkflowRunLimits {
  return {
    maxNodeExecutions: stricterLimit(
      graph.maxNodeExecutions,
      settings['workflows.maxNodeExecutions'],
    )!,
    maxParallelBranches: stricterLimit(
      graph.maxParallelBranches,
      settings['workflows.maxParallelBranches'],
    )!,
    maxLifetimeSeconds: stricterLimit(
      graph.maxLifetimeSeconds,
      settings['workflows.maxLifetimeSeconds'],
    )!,
    budgetMicroUsd: stricterLimit(
      graph.budgetMicroUsd,
      settings['workflows.budgetMicroUsdPerRun'],
    )!,
  };
}

/**
 * How often an attempt that failed with `retryable` is tried in total, unless
 * its node type says fewer. Only a node whose side effects are idempotent or
 * keyed by the attempt's idempotency key retries at all.
 */
export const WORKFLOW_DEFAULT_MAX_ATTEMPTS = 3;

/** How a run waits between the attempts of one node: 10 s, 40 s, 160 s. */
export function workflowRetryDelayMs(failedAttempt: number): number {
  return 10_000 * 4 ** Math.max(0, failedAttempt - 1);
}

/**
 * Why a run or an attempt ended other than with success, as stable codes. A
 * reader branches on the code; the message beside it is for a person.
 */
export const WORKFLOW_RUN_ERROR_CODES = [
  /** `workflows.enabled` was switched off while the run was in flight. */
  'workflow_disabled',
  /** The run would have made more node attempts than `maxNodeExecutions`. */
  'workflow_node_limit',
  /** The run outlived `maxLifetimeSeconds`. */
  'workflow_lifetime_exceeded',
  /** The run spent its budget and had more to do. */
  'workflow_budget_exhausted',
  /** A person cancelled it. */
  'workflow_cancelled',
  /** An `end` node with outcome `failed` or `cancelled` was reached. */
  'workflow_end_outcome',
  /** A node failed and nothing after it could run. */
  'workflow_node_failed',
  /** The run's version no longer parses, which only a damaged row can cause. */
  'workflow_graph_unreadable',
  /** A node's handler threw something nobody classified. */
  'workflow_node_error',
  /** The worker running a node vanished and the node may not be repeated. */
  'workflow_node_interrupted',
  /** A node whose handler needs something this worker was started without. */
  'workflow_node_not_executable',
  /** The API refused to create an agent node's work item or to start its run (issue #162). */
  'workflow_agent_refused',
  /** An agent node's work item was closed as failed. */
  'workflow_work_item_failed',
  /** An agent node's work item was cancelled. */
  'workflow_work_item_cancelled',
  /** An agent node's work item was deleted while the node waited for it. */
  'workflow_work_item_gone',
  /** An agent node's work is open, but no run is working on it and nothing it waits for is pending. */
  'workflow_work_item_stalled',
  /** An agent node's structured result does not match the fields it declared. */
  'workflow_output_invalid',
  /** A waiting node was woken by something it does not know how to resume from. */
  'workflow_resume_unsupported',
  /**
   * An approval node's attention item is gone, or was settled without an
   * approve or a reject (issue #163).
   */
  'workflow_approval_gone',
] as const;
export type WorkflowRunErrorCode = (typeof WORKFLOW_RUN_ERROR_CODES)[number];

/**
 * The history of a run, as facts. Each event names the node and attempt it is
 * about where there is one; `detail` holds ids, handles, durations and error
 * classes, never the content a node read or wrote.
 */
export const WORKFLOW_RUN_EVENT_TYPES = [
  'run.started',
  'run.finished',
  'run.cancelled',
  'run.limit_reached',
  'node.queued',
  'node.started',
  'node.succeeded',
  'node.failed',
  'node.retry_scheduled',
  'node.waiting',
  'node.resumed',
  'node.skipped',
  'node.cancelled',
  'node.recovered',
  'edge.taken',
] as const;
export const workflowRunEventTypeSchema = z.enum(WORKFLOW_RUN_EVENT_TYPES);
export type WorkflowRunEventType = z.infer<typeof workflowRunEventTypeSchema>;

/**
 * Header the worker uses to tell the API which workflow node is writing:
 * `<workflowId>:<runId>:<executionId>:<depth>`. Accepted only on a service
 * token, like the automation origin, and stamped onto every outbox row the
 * request writes, so a workflow never starts from a change it made itself and
 * a chain through automations and workflows stops at `AUTOMATION_MAX_DEPTH`.
 */
export const WORKFLOW_ORIGIN_HEADER = 'x-exocortex-workflow';

export interface WorkflowOrigin {
  workflowId: string;
  runId: string;
  executionId: string;
  depth: number;
}

export function formatWorkflowOrigin(origin: WorkflowOrigin): string {
  return [origin.workflowId, origin.runId, origin.executionId, String(origin.depth)].join(':');
}

const ORIGIN_ID = /^[A-Za-z0-9_-]{1,60}$/u;

/**
 * Reads the header strictly: anything that is not three ids and a small depth
 * is no origin at all, because "unparseable" must not quietly become "depth
 * zero" in the decision whether a chain has gone on long enough.
 */
export function parseWorkflowOrigin(raw: string | undefined): WorkflowOrigin | undefined {
  if (raw === undefined || raw.length > 200) return undefined;
  const parts = raw.split(':');
  if (parts.length !== 4) return undefined;
  const [workflowId, runId, executionId, depthText] = parts as [string, string, string, string];
  if (![workflowId, runId, executionId].every((part) => ORIGIN_ID.test(part))) return undefined;
  const depth = Number(depthText);
  if (!/^\d{1,3}$/u.test(depthText) || depth > 100) return undefined;
  return { workflowId, runId, executionId, depth };
}

/**
 * How long a changed page waits before an event trigger starts its workflow.
 * A page somebody is typing into changes every few seconds; one run per
 * minute of typing is the most an event should ever cost.
 */
export const WORKFLOW_EVENT_DEBOUNCE_MS = 60_000;

/** A schedule trigger's schedule in the shape `nextAutomationRun` reads (ADR-038). */
export function workflowScheduleAsAutomation(schedule: WorkflowSchedule): AutomationSchedule {
  return {
    kind: schedule.kind,
    at: schedule.kind === 'ONCE' ? new Date(schedule.at) : null,
    time: 'time' in schedule ? schedule.time : null,
    weekday: schedule.kind === 'WEEKLY' ? schedule.weekday : null,
    dayOfMonth: schedule.kind === 'MONTHLY' ? schedule.dayOfMonth : null,
    cron: schedule.kind === 'CRON' ? schedule.cron : null,
    timeZone: schedule.timeZone,
  };
}

/** When a schedule trigger fires next after `after`, or null when it never will again. */
export function nextWorkflowScheduleRun(schedule: WorkflowSchedule, after: Date): Date | null {
  return nextAutomationRun(workflowScheduleAsAutomation(schedule), after);
}
