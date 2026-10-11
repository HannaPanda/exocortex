import { describe, expect, it, vi } from 'vitest';

import { AI_RUN_EVENT_LIMIT, type AiRunEventData } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { RunTimeline } from './timeline';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const retry: AiRunEventData = { kind: 'truncation_retry', data: { attempt: 1, toolCall: false } };

function fakePrisma(create: (args: { data: { sequence: number } }) => Promise<unknown>) {
  return { aiRunEvent: { create } } as unknown as PrismaClient;
}

describe('the run timeline (issue #145)', () => {
  it('numbers steps in the order they were recorded', async () => {
    const sequences: number[] = [];
    const timeline = new RunTimeline(
      fakePrisma(async ({ data }) => {
        sequences.push(data.sequence);
      }),
      'run-1',
      logger,
    );
    timeline.record(retry);
    timeline.record(retry);
    timeline.record(retry);
    await timeline.flush();
    expect(sequences).toEqual([1, 2, 3]);
  });

  it('never fails the run over a step it could not write', async () => {
    let calls = 0;
    const timeline = new RunTimeline(
      fakePrisma(async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection lost');
      }),
      'run-1',
      logger,
    );
    timeline.record(retry);
    timeline.record(retry);
    await expect(timeline.flush()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it('stops at the event limit instead of growing without bound', async () => {
    let calls = 0;
    const timeline = new RunTimeline(
      fakePrisma(async () => {
        calls += 1;
      }),
      'run-1',
      logger,
    );
    for (let index = 0; index < AI_RUN_EVENT_LIMIT + 5; index += 1) timeline.record(retry);
    await timeline.flush();
    expect(calls).toBe(AI_RUN_EVENT_LIMIT);
  });

  it('records a measured step only when the description asks for one', async () => {
    const kinds: string[] = [];
    const timeline = new RunTimeline(
      fakePrisma(async (args) => {
        kinds.push((args.data as unknown as { kind: string }).kind);
      }),
      'run-1',
      logger,
    );
    await timeline.timed(
      async () => ({ compacted: false }),
      (result) =>
        result.compacted
          ? { kind: 'compaction', data: { summarizedMessages: 4, trigger: 'prepare' } }
          : null,
    );
    await timeline.timed(
      async () => ({ compacted: true }),
      () => ({ kind: 'compaction', data: { summarizedMessages: 4, trigger: 'prepare' } }),
    );
    await timeline.flush();
    expect(kinds).toEqual(['compaction']);
  });
});
