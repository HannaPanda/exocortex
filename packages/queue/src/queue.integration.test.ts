import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { type ApplicationEvent, QUEUE_NAMES } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';

import { RedisEventBus } from './event-bus';
import { QueueRegistry, testQueuePrefix } from './registry';
import { createTypedWorker } from './worker';

/**
 * Queue integration tests against the Redis instance from `pnpm infra:up`.
 *
 * The debounce and deduplication behaviour is what keeps a stream of keystrokes
 * from turning into a stream of jobs, so it is verified against real Redis rather
 * than a mock.
 *
 * That Redis is shared with the deployment running on the same machine, so every
 * queue here lives under this suite's own prefix. Without it the queue names are
 * the live ones: jobs enqueued below were consumed by the live
 * `exocortex-worker`, and the `obliterate` in `afterAll` erased the live
 * materialization queue.
 */
loadDotEnv();

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const prefix = testQueuePrefix('queue-registry');
const logger = createLogger({ name: 'queue-test', level: 'silent' });

let queues: QueueRegistry;

function materializePayload(documentId: string) {
  return {
    correlationId: `corr-${documentId}`,
    documentId,
    workspaceId: 'workspace-test-0001',
    yjsUpdatedAt: Date.now(),
    reason: 'collaboration_store' as const,
  };
}

beforeAll(() => {
  queues = new QueueRegistry({ redisUrl, logger, prefix });
});

/** Waits for a condition, so a test never sleeps longer than it has to. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the queue');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterAll(async () => {
  await queues.obliterateAll();
  await queues.close();
});

describe('QueueRegistry', () => {
  it('validates the payload before writing to Redis', async () => {
    await expect(
      // @ts-expect-error deliberately invalid payload
      queues.enqueue(QUEUE_NAMES.documentMaterialization, { documentId: 'x' }),
    ).rejects.toThrow();
  });

  it('rejects a job id containing a colon', async () => {
    const documentId = `doc-colon-${Date.now().toString(36)}`;
    await expect(
      queues.enqueueDebounced(QUEUE_NAMES.documentMaterialization, materializePayload(documentId), {
        jobId: `materialize:${documentId}`,
      }),
    ).rejects.toThrow(/must not contain/);
  });

  it('collapses repeated debounced enqueues into a single delayed job', async () => {
    const documentId = `doc-debounce-${Date.now().toString(36)}`;
    const jobId = `materialize-${documentId}`;

    const first = await queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      materializePayload(documentId),
      { jobId, delayMs: 5_000 },
    );
    const second = await queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      materializePayload(documentId),
      { jobId, delayMs: 5_000 },
    );
    const third = await queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      materializePayload(documentId),
      { jobId, delayMs: 5_000 },
    );

    expect(second).toBe(first);
    expect(third).toBe(first);

    const queue = queues.getQueue(QUEUE_NAMES.documentMaterialization);
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(await job?.getState()).toBe('delayed');

    await job?.remove();
  });

  it('keeps the latest payload when a debounced job is postponed', async () => {
    const documentId = `doc-payload-${Date.now().toString(36)}`;
    const jobId = `materialize-${documentId}`;

    await queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      { ...materializePayload(documentId), yjsUpdatedAt: 1_000 },
      { jobId, delayMs: 5_000 },
    );
    await queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      { ...materializePayload(documentId), yjsUpdatedAt: 2_000 },
      { jobId, delayMs: 5_000 },
    );

    const job = await queues.getQueue(QUEUE_NAMES.documentMaterialization).getJob(jobId);
    expect(job?.data.yjsUpdatedAt).toBe(2_000);
    await job?.remove();
  });

  it('enqueues again once the debounced job has already run', async () => {
    // The case the two tests above do not reach, and the one that was wrong:
    // BullMQ keeps a *completed* job under its custom id until
    // `removeOnComplete` ages it out, and `add` under a taken id hands back the
    // finished job and adds nothing -- no error, no second run. With a fixed id
    // like `materialize-<documentId>` that meant one materialization per
    // document per retention window: the first save of a page derived its
    // Markdown, its references and its search projection, and every save for
    // the next hour derived nothing while every caller saw a job id come back.
    const documentId = `doc-rerun-${Date.now().toString(36)}`;
    const jobId = `materialize-${documentId}`;
    const ran: number[] = [];

    const { worker, connection } = createTypedWorker({
      name: QUEUE_NAMES.documentMaterialization,
      redisUrl,
      logger,
      prefix,
      concurrency: 1,
      handler: ({ payload }) => {
        // This worker consumes the whole queue while it is up, so it only
        // counts the document this test enqueued.
        if (payload.documentId === documentId) ran.push(payload.yjsUpdatedAt);
        return Promise.resolve();
      },
    });

    try {
      for (const [index, yjsUpdatedAt] of [1_000, 2_000, 3_000].entries()) {
        await queues.enqueueDebounced(
          QUEUE_NAMES.documentMaterialization,
          { ...materializePayload(documentId), yjsUpdatedAt },
          { jobId, delayMs: 10 },
        );
        await waitFor(() => ran.length === index + 1);
      }
    } finally {
      await worker.close();
      await connection.quit();
    }

    expect(ran).toEqual([1_000, 2_000, 3_000]);
  }, 20_000);

  it('answers a Redis ping', async () => {
    expect(await queues.ping()).toBe(true);
  });

  it('gives the ai queue its own retry policy', async () => {
    // createAiRunProcessor never throws on a provider or timeout failure --
    // it writes a terminal status itself -- so a BullMQ retry would only
    // ever fire for an infrastructure error, and would pay for the prompt a
    // second time (ADR-017).
    const runId = `run-${Date.now().toString(36)}`;
    const jobId = await queues.enqueue(QUEUE_NAMES.ai, {
      correlationId: `corr-${runId}`,
      runId,
      workspaceId: 'workspace-test-0001',
      userId: 'user-test-00001',
    });

    const job = await queues.getQueue(QUEUE_NAMES.ai).getJob(jobId);
    expect(job?.opts.attempts).toBe(1);
    await job?.remove();
  });
});

describe('createTypedWorker', () => {
  it('consumes a job the registry enqueued under the same prefix', async () => {
    // A `Worker` polls for jobs the moment it is constructed (BullMQ's `autorun`
    // defaults to `true`). Under the live prefix that meant racing the real
    // `exocortex-worker` for real jobs, which is why this was untested before.
    // The test now doubles as the proof that producer and consumer agree on the
    // prefix: a mismatch leaves the handler waiting forever.
    const documentId = `doc-worker-${Date.now().toString(36)}`;
    const handled = new Promise<{ documentId: string; progress: number[] }>((resolve, reject) => {
      const progress: number[] = [];
      const { worker, connection } = createTypedWorker({
        name: QUEUE_NAMES.documentMaterialization,
        redisUrl,
        logger,
        prefix,
        handler: async ({ payload, reportProgress }) => {
          await reportProgress(50, 'Seite wird verarbeitet');
          progress.push(50);
          // Closing from inside the handler would deadlock; hand the result out
          // and let the assertions below tear the worker down.
          setTimeout(() => {
            void worker
              .close()
              .then(() => connection.quit())
              .then(() => {
                resolve({ documentId: payload.documentId, progress });
              })
              .catch(reject);
          }, 0);
        },
      });
      worker.on('error', reject);
    });

    await queues.enqueue(QUEUE_NAMES.documentMaterialization, materializePayload(documentId));

    const result = await handled;
    expect(result.documentId).toBe(documentId);
    expect(result.progress).toEqual([50]);
  }, 20_000);
});

describe('RedisEventBus', () => {
  it('delivers a validated event to a subscriber', async () => {
    const publisher = new RedisEventBus({ redisUrl, logger, channel: 'exocortex:test-events' });
    const subscriber = new RedisEventBus({ redisUrl, logger, channel: 'exocortex:test-events' });

    const received: ApplicationEvent[] = [];
    await subscriber.subscribe((event) => {
      received.push(event);
    });

    const event: ApplicationEvent = {
      type: 'job.progress',
      workspaceId: 'workspace-test-0001',
      correlationId: 'corr-bus',
      emittedAt: new Date().toISOString(),
      payload: {
        jobId: '1',
        queue: QUEUE_NAMES.documentMaterialization,
        progress: 42,
        label: 'Seite wird verarbeitet',
      },
    };
    await publisher.publish(event);

    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('job.progress');
    expect(received[0]?.payload).toMatchObject({ progress: 42 });

    await subscriber.close();
    await publisher.close();
  });

  it('refuses to publish an invalid event', async () => {
    const bus = new RedisEventBus({ redisUrl, logger, channel: 'exocortex:test-events' });
    await expect(
      // @ts-expect-error deliberately invalid event
      bus.publish({ type: 'job.progress', workspaceId: 'w', payload: {} }),
    ).rejects.toThrow(/Refusing to publish/);
    await bus.close();
  });
});
