import { describe, expect, it } from 'vitest';

import {
  AI_QUEUE_LOCK_DURATION_MS,
  AI_RUN_HEARTBEAT_INTERVAL_MS,
  AI_RUN_HEARTBEAT_STALE_MS,
  AI_RUN_POLL_INTERVAL_MS,
  AI_TOOL_CALL_TIMEOUT_MS,
  deriveAiRunTimeouts,
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

  it("carries the fixed heartbeat constants through, not derived from settings", () => {
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
