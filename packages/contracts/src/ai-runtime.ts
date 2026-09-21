import { type AiRunStatus } from './ai';
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

/**
 * Shortest gap between two `ai.run.phase` events of the same phase. Reasoning
 * arrives as a stream of tiny fragments; republishing every one of them would
 * turn a life sign into a flood without telling anybody more than the first
 * one did.
 */
export const AI_RUN_PHASE_MIN_INTERVAL_MS = 2_000;

/** Ceiling for a single tool call made by the built-in AI's tool loop. */
export const AI_TOOL_CALL_TIMEOUT_MS = 60_000;

/** Statuses that mean the worker is finished with a run, either way. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AiRunStatus> = new Set<AiRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isAiRunTerminalStatus(status: AiRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

// --------------------------------------------------------------------------
// Client-side run tracking (issue #6)
//
// Pure functions rather than logic inside the React panel, because this is
// exactly the part that has to be provable: that a lost completion event is
// caught by the poll, that the clock measures silence and not merely uptime,
// and that a hole in the delta stream is noticed instead of swallowed.
// --------------------------------------------------------------------------

/**
 * What a client knows about `ai.run.progress`'s monotonic `sequence`: the
 * number it expects next, and whether it has ever missed one.
 *
 * `gap` is deliberately sticky for the lifetime of a run. A client that saw a
 * hole cannot trust anything it stitched together afterwards either, so one
 * missed delta keeps the reload path armed until the run ends.
 */
export interface AiRunSequenceState {
  expected: number;
  gap: boolean;
}

/** The provider counts its deltas from 1, so that is what the first event carries. */
export const INITIAL_AI_RUN_SEQUENCE_STATE: AiRunSequenceState = { expected: 1, gap: false };

export function advanceAiRunSequence(
  state: AiRunSequenceState,
  sequence: number,
): AiRunSequenceState {
  return {
    expected: sequence + 1,
    gap: state.gap || sequence !== state.expected,
  };
}

export interface AiRunElapsedInput {
  /** When this client saw the run start. */
  startedAtMs: number | null;
  /** When this client last received any event for the run. */
  lastEventAtMs: number | null;
  /** The worker's own `heartbeatAt`, as last read by the status poll. */
  heartbeatAtMs: number | null;
  nowMs: number;
}

/**
 * Milliseconds since the most recent confirmed sign of life.
 *
 * The heartbeat is in here on purpose: it is the one sign that survives a
 * socket this tab never got anything over, so a run that is demonstrably
 * alive is never reported as quiet just because the events were lost.
 */
export function resolveAiRunElapsedMs(input: AiRunElapsedInput): number {
  const lastSignMs = Math.max(
    input.startedAtMs ?? 0,
    input.lastEventAtMs ?? 0,
    input.heartbeatAtMs ?? 0,
  );
  if (lastSignMs === 0) return 0;
  return Math.max(0, input.nowMs - lastSignMs);
}

/**
 * Whether a run has been silent long enough that the pulse alone stops being
 * reassuring. `ai.timeoutMs` allows three minutes of legitimate silence, so
 * this is a change of tone, never a verdict that the run is dead.
 */
export function isAiRunQuiet(elapsedMs: number): boolean {
  return elapsedMs >= AI_RUN_QUIET_THRESHOLD_MS;
}

export interface AiRunReconcileInput {
  /** The run this client still believes is in flight. */
  activeRunId: string | null;
  /** The run as the server last reported it, or `null` while none was read. */
  run: {
    id: string;
    status: AiRunStatus;
    errorCode: string | null;
    errorDetail: string | null;
  } | null;
  /** `key` of the outcome this client has already reacted to. */
  appliedKey: string | null;
}

export interface AiRunReconcileResult {
  /** Stable per run *and* outcome, so an outcome is applied exactly once. */
  key: string;
  status: AiRunStatus;
  errorCode: string | null;
  /** The German diagnosis the run row carries, when it has one (issue #118). */
  errorDetail: string | null;
}

/**
 * Compares a client's own idea of a run against the server's.
 *
 * This is the safety net the realtime channel cannot be: an `ai.run.completed`
 * lost to a reconnect, a backgrounded tab or a dropped packet used to leave
 * the panel waiting forever, because nothing ever asked. Returns the outcome
 * to apply when the server says the run is over and this client has not acted
 * on that yet, and `null` in every other case, including a run that is still
 * pending or running.
 */
export function reconcileAiRun(input: AiRunReconcileInput): AiRunReconcileResult | null {
  const { activeRunId, run, appliedKey } = input;
  if (activeRunId === null || run === null || run.id !== activeRunId) return null;
  if (!isAiRunTerminalStatus(run.status)) return null;
  const key = `${run.id}:${run.status}`;
  if (key === appliedKey) return null;
  return { key, status: run.status, errorCode: run.errorCode, errorDetail: run.errorDetail };
}

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
