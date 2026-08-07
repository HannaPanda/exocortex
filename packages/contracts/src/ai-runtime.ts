import { type Settings } from './settings';

/**
 * Every timing constant an AI run touches, gathered in one place so the
 * worker, the queue and the admin UI cannot drift apart (issue #16).
 *
 * `ai.timeoutMs` and `ai.maxRunMs` are admin-configurable (`./settings`);
 * everything below is deliberately not, because it is infrastructure, not a
 * product preference an operator would reasonably want to change per
 * deployment.
 */

/**
 * Lock held by the `ai` queue while a job is in flight, and the interval
 * BullMQ uses to decide a job has stalled. Both must comfortably outlast the
 * heartbeat below: the lock is what keeps BullMQ from redelivering a run that
 * is merely slow, and the heartbeat is what tells *us* the same thing on a
 * much shorter cycle. BullMQ itself renews the lock every `lockDuration / 2`.
 */
export const AI_QUEUE_LOCK_DURATION_MS = 300_000;
export const AI_QUEUE_STALLED_INTERVAL_MS = 60_000;

/** How often a running job writes a heartbeat while it works. */
export const AI_RUN_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Twelve missed heartbeats: the worker that held this run is gone (crashed,
 * killed, deployed over), not just slow. A `RUNNING` run with an older
 * heartbeat than this may be reclaimed as abandoned.
 */
export const AI_RUN_HEARTBEAT_STALE_MS = 60_000;

/** A `PENDING` run older than this was never picked up: the job was lost. */
export const AI_RUN_PICKUP_GRACE_MS = 300_000;

/** Grace period the maintenance reaper adds on top of the run budget, so it
 *  never races the worker's own abort. */
export const AI_RUN_REAPER_GRACE_MS = 30_000;

/** How often the web client polls a run's status as a fallback for a missed
 *  realtime event. */
export const AI_RUN_POLL_INTERVAL_MS = 7_000;

/** How long a run may go without a new signal before the UI calls it quiet. */
export const AI_RUN_QUIET_THRESHOLD_MS = 30_000;

/** Ceiling for a single tool call made by the built-in AI's tool loop. */
export const AI_TOOL_CALL_TIMEOUT_MS = 60_000;

export interface AiRunTimeouts {
  /** Limit for one model answer (one turn). */
  turnTimeoutMs: number;
  /** Limit for the whole run, across every turn and tool round-trip. */
  runBudgetMs: number;
  toolCallTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatStaleMs: number;
  /** When the maintenance reaper may treat a `RUNNING` run as timed out. */
  reaperDeadlineMs: number;
}

/**
 * Derives the run-time clocks from the two admin settings.
 *
 * `ai.timeoutMs` governs a single model answer; `ai.maxRunMs` governs the
 * whole run, including every tool round-trip. A run's budget can never be
 * shorter than a single turn's timeout -- otherwise a run with tools enabled
 * could never even finish its first answer -- so the run budget is raised to
 * match the turn timeout if an admin ever sets `ai.maxRunMs` below it.
 */
export function deriveAiRunTimeouts(
  settings: Pick<Settings, 'ai.timeoutMs' | 'ai.maxRunMs'>,
): AiRunTimeouts {
  const turnTimeoutMs = settings['ai.timeoutMs'];
  const runBudgetMs = Math.max(settings['ai.maxRunMs'], turnTimeoutMs);
  return {
    turnTimeoutMs,
    runBudgetMs,
    toolCallTimeoutMs: Math.min(AI_TOOL_CALL_TIMEOUT_MS, runBudgetMs),
    heartbeatIntervalMs: AI_RUN_HEARTBEAT_INTERVAL_MS,
    heartbeatStaleMs: AI_RUN_HEARTBEAT_STALE_MS,
    reaperDeadlineMs: runBudgetMs + AI_RUN_REAPER_GRACE_MS,
  };
}
