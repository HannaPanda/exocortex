import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { type ApplicationEvent, QUEUE_NAMES } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';

import { RedisEventBus } from './event-bus';
import { QueueRegistry } from './registry';

/**
 * Queue integration tests against the Redis instance from `pnpm infra:up`.
 *
 * The debounce and deduplication behaviour is what keeps a stream of keystrokes
 * from turning into a stream of jobs, so it is verified against real Redis rather
 * than a mock.
 */
loadDotEnv();

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
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
  queues = new QueueRegistry({ redisUrl, logger });
});

afterAll(async () => {
  const queue = queues.getQueue(QUEUE_NAMES.documentMaterialization);
  await queue.obliterate({ force: true }).catch(() => {
    // The queue may not exist if every test was skipped; nothing to clean up.
  });
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

  it('answers a Redis ping', async () => {
    expect(await queues.ping()).toBe(true);
  });
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
