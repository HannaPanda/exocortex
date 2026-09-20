import {
  type PushDeliveryJob,
  type PushNotificationPayload,
  type QUEUE_NAMES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type JobContext } from '@exocortex/queue';

import { type PushSender } from '../push/send';

/**
 * Fans one notification out to the devices that asked for that kind
 * (issue #30, ADR-048).
 *
 * The job names a person, never a subscription. Which of their devices hears
 * about it is decided here, at the moment of sending, so a phone whose switch
 * was flipped a minute ago stays quiet and a laptop registered a minute ago
 * does not.
 *
 * A delivery failure for one device never fails the job for the others: the
 * sender classifies each attempt, a dead subscription is deleted on the spot,
 * and the job only throws when *every* device failed in a way worth retrying.
 * Throwing on a partial failure would re-deliver to the devices that already
 * had it.
 */

export interface PushDeliveryDependencies {
  prisma: PrismaClient;
  /** Null on a deployment with no VAPID keys; every job then ends as a no-op. */
  sender: PushSender | null;
}

/**
 * How many consecutive failures a device is given before it is dropped.
 *
 * A push service has bad afternoons, and a laptop that is shut for a week
 * still has a perfectly good subscription. Ten is roughly a fortnight of
 * ordinary notification traffic, after which the row is more likely to be a
 * ghost than a device.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

export function createPushDeliveryProcessor(dependencies: PushDeliveryDependencies) {
  const { prisma, sender } = dependencies;

  return async ({ payload, logger }: JobContext<typeof QUEUE_NAMES.push>): Promise<void> => {
    const job: PushDeliveryJob = payload;
    if (sender === null) {
      logger.debug('Push notification dropped: no VAPID key pair is configured', {
        kind: job.kind,
      });
      return;
    }

    const subscriptions = await prisma.pushSubscription.findMany({
      where: { userId: job.userId, kinds: { has: job.kind } },
      select: { id: true, endpoint: true, p256dh: true, auth: true, failureCount: true },
    });
    if (subscriptions.length === 0) return;

    const notification: PushNotificationPayload = {
      kind: job.kind,
      title: job.notification.title,
      body: job.notification.body,
      url: job.notification.url,
      tag: job.notification.tag,
    };

    let delivered = 0;
    let gone = 0;
    const retryable: string[] = [];

    for (const subscription of subscriptions) {
      const outcome = await sender.send(subscription, notification);

      if (outcome.status === 'delivered') {
        delivered += 1;
        await prisma.pushSubscription.update({
          where: { id: subscription.id },
          data: { lastDeliveredAt: new Date(), failureCount: 0, lastError: null },
        });
        continue;
      }

      if (outcome.status === 'gone') {
        gone += 1;
        // Deleted rather than disabled. A subscription the push service has
        // forgotten can never come back: the browser mints a new endpoint when
        // it asks again, and the old row would sit there for ever looking like
        // a device somebody owns.
        await deleteQuietly(prisma, subscription.id, logger, outcome.reason);
        continue;
      }

      const failures = subscription.failureCount + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        gone += 1;
        await deleteQuietly(prisma, subscription.id, logger, outcome.reason);
        continue;
      }

      retryable.push(outcome.reason);
      await prisma.pushSubscription
        .update({
          where: { id: subscription.id },
          data: { failureCount: failures, lastError: outcome.reason.slice(0, 500) },
        })
        .catch(() => undefined);
      if (outcome.retryAfterSeconds !== null) {
        logger.warn('Push service asked us to slow down', {
          subscriptionId: subscription.id,
          retryAfterSeconds: outcome.retryAfterSeconds,
        });
      }
    }

    logger.debug('Push notification sent', {
      kind: job.kind,
      delivered,
      gone,
      failed: retryable.length,
    });

    // Only a total failure is worth another attempt: anything else would
    // notify the devices that already heard a second time.
    if (delivered === 0 && gone === 0 && retryable.length > 0) {
      throw new Error(`No device could be reached: ${retryable[0]}`);
    }
  };
}

/**
 * Removes a subscription, tolerating one that is already gone.
 *
 * The person may have deleted the device in the browser between the read and
 * the write, and that is not a fault -- the row is gone either way, which is
 * exactly what this wanted.
 */
async function deleteQuietly(
  prisma: PrismaClient,
  id: string,
  logger: Logger,
  reason: string,
): Promise<void> {
  try {
    await prisma.pushSubscription.delete({ where: { id } });
    logger.info('Push subscription removed', { subscriptionId: id, reason });
  } catch {
    // Already gone.
  }
}
