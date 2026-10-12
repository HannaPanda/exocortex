import { describe, expect, it } from 'vitest';

import { type QueueRegistry } from '@exocortex/queue';

import { readCaptureStatus } from './memory-capture-status';

/** A queue holding at most one job, in the shape `captureStatus` reads. */
function serviceWith(
  job: {
    data: { userId: string };
    state: string;
    returnvalue?: unknown;
    failedReason?: string;
  } | null,
) {
  const queues = {
    getQueue: () => ({
      getJob: async () =>
        job === null
          ? undefined
          : {
              data: job.data,
              returnvalue: job.returnvalue,
              failedReason: job.failedReason ?? '',
              getState: async () => job.state,
            },
    }),
  } as unknown as QueueRegistry;
  return {
    captureStatus: (userId: string, jobId: string) => readCaptureStatus(queues, userId, jobId),
  };
}

describe('readCaptureStatus (issue #188)', () => {
  it('reports the note a completed capture wrote', async () => {
    const service = serviceWith({
      data: { userId: 'user-1' },
      state: 'completed',
      returnvalue: { outcome: 'written', documentId: 'doc-12345' },
    });

    await expect(service.captureStatus('user-1', '7')).resolves.toEqual({
      jobId: '7',
      state: 'completed',
      outcome: 'written',
      documentId: 'doc-12345',
      reason: null,
    });
  });

  it('tells a completed job that wrote nothing apart from one that wrote a note', async () => {
    const service = serviceWith({
      data: { userId: 'user-1' },
      state: 'completed',
      returnvalue: { outcome: 'nothing_to_remember', documentId: null },
    });

    const status = await service.captureStatus('user-1', '7');
    expect(status.outcome).toBe('nothing_to_remember');
    expect(status.documentId).toBeNull();
  });

  it('answers for somebody else exactly as for a job that does not exist', async () => {
    const foreign = await serviceWith({
      data: { userId: 'user-2' },
      state: 'completed',
      returnvalue: { outcome: 'written', documentId: 'doc-12345' },
    }).captureStatus('user-1', '7');
    const missing = await serviceWith(null).captureStatus('user-1', '7');

    expect(foreign).toEqual(missing);
    expect(missing.state).toBe('not_found');
  });

  it('passes the failure reason on and maps the waiting states', async () => {
    const failed = await serviceWith({
      data: { userId: 'user-1' },
      state: 'failed',
      failedReason: 'Redis went away',
    }).captureStatus('user-1', '7');
    expect(failed).toMatchObject({ state: 'failed', reason: 'Redis went away' });

    const running = await serviceWith({
      data: { userId: 'user-1' },
      state: 'active',
    }).captureStatus('user-1', '7');
    expect(running.state).toBe('running');

    const waiting = await serviceWith({
      data: { userId: 'user-1' },
      state: 'waiting',
    }).captureStatus('user-1', '7');
    expect(waiting.state).toBe('queued');
  });

  it('says completed without an outcome for a job from an older worker', async () => {
    const status = await serviceWith({
      data: { userId: 'user-1' },
      state: 'completed',
      returnvalue: null,
    }).captureStatus('user-1', '7');
    expect(status).toMatchObject({ state: 'completed', outcome: null, documentId: null });
  });
});
