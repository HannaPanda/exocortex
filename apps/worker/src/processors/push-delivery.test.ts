import { describe, expect, it, vi } from 'vitest';

import { type PrismaClient } from '@exocortex/database';

import { type PushOutcome, type PushSender, type PushTarget } from '../push/send';

import { createPushDeliveryProcessor } from './push-delivery';

/**
 * The processor's decisions, without a database.
 *
 * Everything worth testing here is a branch: which devices are asked, what
 * happens to a row after each kind of failure, and when the job throws. A
 * stub for `pushSubscription` is enough for all of them, and an integration
 * test would prove the same branches slower.
 */

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
}

function prismaWith(rows: Row[]) {
  const deleted: string[] = [];
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const findMany = vi.fn(async () => rows);

  const prisma = {
    pushSubscription: {
      findMany,
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data });
          return {};
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        return {};
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, deleted, updates, findMany };
}

function senderReturning(outcomes: Record<string, PushOutcome>): PushSender {
  return {
    send: vi.fn(
      async (target: PushTarget): Promise<PushOutcome> =>
        outcomes[target.endpoint] ?? { status: 'delivered' },
    ),
  };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<ReturnType<typeof createPushDeliveryProcessor>>[0]['logger'];

function job(overrides: Partial<{ kind: 'AGENT' | 'COMMENT' | 'CALENDAR' }> = {}) {
  return {
    payload: {
      correlationId: 'c1',
      userId: 'u1',
      kind: overrides.kind ?? ('AGENT' as const),
      notification: { title: 'T', body: 'B', url: null, tag: null },
    },
    logger,
  } as unknown as Parameters<ReturnType<typeof createPushDeliveryProcessor>>[0];
}

const device = (id: string, failureCount = 0): Row => ({
  id,
  endpoint: `https://push.test/${id}`,
  p256dh: 'p',
  auth: 'a',
  failureCount,
});

describe('createPushDeliveryProcessor', () => {
  it('asks only for the devices that accept this kind', async () => {
    const { prisma, findMany } = prismaWith([device('d1')]);
    await createPushDeliveryProcessor({ prisma, sender: senderReturning({}) })(
      job({ kind: 'COMMENT' }),
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', kinds: { has: 'COMMENT' } },
      }),
    );
  });

  it('does nothing at all when no key pair is configured', async () => {
    const { prisma, findMany } = prismaWith([device('d1')]);
    await createPushDeliveryProcessor({ prisma, sender: null })(job());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('clears the failure count of a device that answered', async () => {
    const { prisma, updates } = prismaWith([device('d1', 4)]);
    await createPushDeliveryProcessor({ prisma, sender: senderReturning({}) })(job());

    expect(updates).toHaveLength(1);
    expect(updates[0]?.data).toMatchObject({ failureCount: 0, lastError: null });
  });

  it('deletes a subscription the push service says is gone', async () => {
    const { prisma, deleted } = prismaWith([device('d1')]);
    const sender = senderReturning({
      'https://push.test/d1': { status: 'gone', reason: 'Push service answered 410' },
    });

    await createPushDeliveryProcessor({ prisma, sender })(job());
    expect(deleted).toEqual(['d1']);
  });

  it('counts a retryable failure instead of deleting the device', async () => {
    const { prisma, deleted, updates } = prismaWith([device('d1', 2)]);
    const sender = senderReturning({
      'https://push.test/d1': { status: 'failed', reason: 'timeout', retryAfterSeconds: null },
    });

    await expect(createPushDeliveryProcessor({ prisma, sender })(job())).rejects.toThrow(/timeout/);
    expect(deleted).toEqual([]);
    expect(updates[0]?.data).toMatchObject({ failureCount: 3 });
  });

  it('retires a device that has failed ten times in a row', async () => {
    const { prisma, deleted } = prismaWith([device('d1', 9)]);
    const sender = senderReturning({
      'https://push.test/d1': { status: 'failed', reason: 'timeout', retryAfterSeconds: null },
    });

    // Not a throw: the device was dealt with, so there is nothing to retry.
    await createPushDeliveryProcessor({ prisma, sender })(job());
    expect(deleted).toEqual(['d1']);
  });

  it('never re-delivers to the devices that already heard, so a partial failure does not throw', async () => {
    const { prisma } = prismaWith([device('d1'), device('d2')]);
    const sender = senderReturning({
      'https://push.test/d2': { status: 'failed', reason: 'timeout', retryAfterSeconds: null },
    });

    await expect(createPushDeliveryProcessor({ prisma, sender })(job())).resolves.toBeUndefined();
  });

  it('throws only when every device failed retryably', async () => {
    const { prisma } = prismaWith([device('d1'), device('d2')]);
    const sender = senderReturning({
      'https://push.test/d1': { status: 'failed', reason: 'one', retryAfterSeconds: null },
      'https://push.test/d2': { status: 'failed', reason: 'two', retryAfterSeconds: null },
    });

    await expect(createPushDeliveryProcessor({ prisma, sender })(job())).rejects.toThrow(
      /No device could be reached/,
    );
  });
});
