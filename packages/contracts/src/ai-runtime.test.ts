import { describe, expect, it } from 'vitest';

import {
  advanceAiRunSequence,
  AI_QUEUE_LOCK_DURATION_MS,
  AI_RUN_HEARTBEAT_INTERVAL_MS,
  AI_RUN_HEARTBEAT_STALE_MS,
  AI_RUN_PHASE_MIN_INTERVAL_MS,
  AI_RUN_POLL_INTERVAL_MS,
  AI_RUN_QUIET_THRESHOLD_MS,
  AI_TOOL_CALL_TIMEOUT_MS,
  deriveAiRunTimeouts,
  INITIAL_AI_RUN_SEQUENCE_STATE,
  isAiRunQuiet,
  isAiRunTerminalStatus,
  reconcileAiRun,
  resolveAiRunElapsedMs,
} from './ai-runtime';
import { settingsSchema } from './settings';

const defaults = settingsSchema.parse({});

describe('deriveAiRunTimeouts', () => {
  it('uses ai.timeoutMs for the turn and ai.maxRunMs for the whole run by default', () => {
    const timeouts = deriveAiRunTimeouts(defaults);
    expect(timeouts.turnTimeoutMs).toBe(defaults['ai.timeoutMs']);
    expect(timeouts.runBudgetMs).toBe(defaults['ai.maxRunMs']);
  });

  it('never lets the run budget undercut a single turn timeout', () => {
    // An admin setting ai.maxRunMs below ai.timeoutMs would otherwise leave a
    // run with tools enabled unable to finish even its first answer.
    const timeouts = deriveAiRunTimeouts({ 'ai.timeoutMs': 600_000, 'ai.maxRunMs': 60_000 });
    expect(timeouts.runBudgetMs).toBe(600_000);
    expect(timeouts.runBudgetMs).toBeGreaterThanOrEqual(timeouts.turnTimeoutMs);
  });

  it('caps the tool-call timeout at the run budget when the budget is smaller', () => {
    const timeouts = deriveAiRunTimeouts({ 'ai.timeoutMs': 60_000, 'ai.maxRunMs': 60_000 });
    expect(timeouts.toolCallTimeoutMs).toBeLessThanOrEqual(timeouts.runBudgetMs);
    expect(timeouts.toolCallTimeoutMs).toBe(60_000);
  });

  it('otherwise uses the fixed tool-call ceiling', () => {
    const timeouts = deriveAiRunTimeouts(defaults);
    expect(timeouts.toolCallTimeoutMs).toBe(AI_TOOL_CALL_TIMEOUT_MS);
  });

  it('adds the reaper grace period on top of the run budget', () => {
    const timeouts = deriveAiRunTimeouts(defaults);
    expect(timeouts.reaperDeadlineMs).toBeGreaterThan(timeouts.runBudgetMs);
  });

  it('carries the fixed heartbeat constants through, not derived from settings', () => {
    const timeouts = deriveAiRunTimeouts(defaults);
    expect(timeouts.heartbeatIntervalMs).toBe(AI_RUN_HEARTBEAT_INTERVAL_MS);
    expect(timeouts.heartbeatStaleMs).toBe(AI_RUN_HEARTBEAT_STALE_MS);
  });

  it('keeps the documented ordering between the fixed constants', () => {
    // Enough missed heartbeats before "stale", not a hair-trigger on one
    // slow tick; the queue's own lock comfortably outlasts staleness; and the
    // web client's poll is frequent enough to matter well before staleness.
    expect(AI_RUN_HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(AI_RUN_HEARTBEAT_STALE_MS);
    expect(AI_RUN_HEARTBEAT_STALE_MS).toBeLessThanOrEqual(AI_QUEUE_LOCK_DURATION_MS);
    expect(AI_RUN_POLL_INTERVAL_MS).toBeLessThan(AI_RUN_HEARTBEAT_STALE_MS);
  });
});

describe('reconcileAiRun', () => {
  const run = { id: 'run1234567', status: 'completed', errorCode: null } as const;

  it('catches a completion event the socket never delivered (issue #6)', () => {
    // The whole point of the poll: the panel still believes the run is in
    // flight, nothing on the socket ever said otherwise, and the server has
    // known for a while that it is over.
    const result = reconcileAiRun({ activeRunId: run.id, run, appliedKey: null });
    expect(result).toEqual({ key: 'run1234567:completed', status: 'completed', errorCode: null });
  });

  it('carries the error code of a failed run through', () => {
    const result = reconcileAiRun({
      activeRunId: run.id,
      run: { ...run, status: 'failed', errorCode: 'ai_response_truncated' },
      appliedKey: null,
    });
    expect(result?.status).toBe('failed');
    expect(result?.errorCode).toBe('ai_response_truncated');
  });

  it('stays silent while the run is still pending or running', () => {
    expect(
      reconcileAiRun({ activeRunId: run.id, run: { ...run, status: 'pending' }, appliedKey: null }),
    ).toBeNull();
    expect(
      reconcileAiRun({ activeRunId: run.id, run: { ...run, status: 'running' }, appliedKey: null }),
    ).toBeNull();
  });

  it('applies an outcome exactly once', () => {
    const first = reconcileAiRun({ activeRunId: run.id, run, appliedKey: null });
    expect(first).not.toBeNull();
    expect(reconcileAiRun({ activeRunId: run.id, run, appliedKey: first?.key ?? null })).toBeNull();
  });

  it('ignores a run the panel is not watching', () => {
    expect(reconcileAiRun({ activeRunId: 'other12345', run, appliedKey: null })).toBeNull();
    expect(reconcileAiRun({ activeRunId: null, run, appliedKey: null })).toBeNull();
    expect(reconcileAiRun({ activeRunId: run.id, run: null, appliedKey: null })).toBeNull();
  });

  it('agrees with isAiRunTerminalStatus about what "over" means', () => {
    expect(isAiRunTerminalStatus('completed')).toBe(true);
    expect(isAiRunTerminalStatus('failed')).toBe(true);
    expect(isAiRunTerminalStatus('cancelled')).toBe(true);
    expect(isAiRunTerminalStatus('timed_out')).toBe(true);
    expect(isAiRunTerminalStatus('pending')).toBe(false);
    expect(isAiRunTerminalStatus('running')).toBe(false);
  });
});

describe('advanceAiRunSequence', () => {
  it('follows an unbroken run of deltas without reporting a gap', () => {
    let state = INITIAL_AI_RUN_SEQUENCE_STATE;
    for (const sequence of [1, 2, 3, 4]) {
      state = advanceAiRunSequence(state, sequence);
    }
    expect(state).toEqual({ expected: 5, gap: false });
  });

  it('notices a delta that never arrived', () => {
    // 3 is missing: the text the client stitched together has a hole in it
    // that no further delta will ever fill.
    let state = advanceAiRunSequence(INITIAL_AI_RUN_SEQUENCE_STATE, 1);
    state = advanceAiRunSequence(state, 2);
    state = advanceAiRunSequence(state, 4);
    expect(state.gap).toBe(true);
    expect(state.expected).toBe(5);
  });

  it('keeps the gap flag raised once it has been raised', () => {
    // Sticky on purpose: everything after a hole is suspect too, so the
    // reload path stays armed for the rest of the run.
    let state = advanceAiRunSequence(INITIAL_AI_RUN_SEQUENCE_STATE, 2);
    expect(state.gap).toBe(true);
    state = advanceAiRunSequence(state, 3);
    state = advanceAiRunSequence(state, 4);
    expect(state.gap).toBe(true);
  });

  it('treats a repeated sequence number as a gap as well', () => {
    let state = advanceAiRunSequence(INITIAL_AI_RUN_SEQUENCE_STATE, 1);
    state = advanceAiRunSequence(state, 1);
    expect(state.gap).toBe(true);
  });
});

describe('resolveAiRunElapsedMs', () => {
  const start = 1_000_000;

  it('measures from the run start while nothing else has happened', () => {
    const elapsed = resolveAiRunElapsedMs({
      startedAtMs: start,
      lastEventAtMs: null,
      heartbeatAtMs: null,
      nowMs: start + 12_000,
    });
    expect(elapsed).toBe(12_000);
  });

  it('measures from the last event once one arrived', () => {
    const elapsed = resolveAiRunElapsedMs({
      startedAtMs: start,
      lastEventAtMs: start + 20_000,
      heartbeatAtMs: null,
      nowMs: start + 25_000,
    });
    expect(elapsed).toBe(5_000);
  });

  it("falls back to the worker's heartbeat when this tab received nothing", () => {
    // The socket dropped everything; the poll still sees a worker that is
    // demonstrably alive, and that must count as a sign of life.
    const elapsed = resolveAiRunElapsedMs({
      startedAtMs: start,
      lastEventAtMs: null,
      heartbeatAtMs: start + 40_000,
      nowMs: start + 43_000,
    });
    expect(elapsed).toBe(3_000);
  });

  it('reports nothing elapsed before there is any sign at all', () => {
    const elapsed = resolveAiRunElapsedMs({
      startedAtMs: null,
      lastEventAtMs: null,
      heartbeatAtMs: null,
      nowMs: start,
    });
    expect(elapsed).toBe(0);
  });

  it('never goes negative when a clock runs backwards', () => {
    const elapsed = resolveAiRunElapsedMs({
      startedAtMs: start + 5_000,
      lastEventAtMs: null,
      heartbeatAtMs: null,
      nowMs: start,
    });
    expect(elapsed).toBe(0);
  });
});

describe('isAiRunQuiet', () => {
  it('stays calm below the threshold and speaks up at it', () => {
    expect(isAiRunQuiet(AI_RUN_QUIET_THRESHOLD_MS - 1)).toBe(false);
    expect(isAiRunQuiet(AI_RUN_QUIET_THRESHOLD_MS)).toBe(true);
  });

  it('crosses well before a single turn may legitimately time out', () => {
    // Three minutes of silence are allowed by ai.timeoutMs's default, so the
    // threshold has to be a change of tone long before that, not a verdict.
    expect(AI_RUN_QUIET_THRESHOLD_MS).toBeLessThan(defaults['ai.timeoutMs']);
    expect(isAiRunQuiet(defaults['ai.timeoutMs'])).toBe(true);
  });

  it('leaves room for several phase events inside one quiet window', () => {
    expect(AI_RUN_PHASE_MIN_INTERVAL_MS * 4).toBeLessThanOrEqual(AI_RUN_QUIET_THRESHOLD_MS);
  });
});
