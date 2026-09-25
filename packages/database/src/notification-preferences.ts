import {
  ACCOUNT_NOTIFICATION_PAIRS,
  type NotificationChannel,
  type NotificationDeliveryMode,
  type NotificationKind,
  type NotificationPreference,
  notificationSupport,
} from '@exocortex/contracts';

import type { PrismaClient } from './client';

/**
 * The one place that answers "should this person hear about this, over this
 * channel, right now" (issue #105, ADR-052).
 *
 * It lives here rather than in a service because both halves of the deployment
 * have to ask it and neither may be the one that owns it: the API asks while
 * answering the settings page, and the worker asks while dispatching the
 * outbox, which is where nearly every notification is actually decided. A copy
 * in each would be two policies, and the one that forgot a case would be the
 * one that mailed somebody who had switched it off.
 *
 * What it deliberately does not do is decide *who* is a recipient. Whether
 * somebody may still read the page is a different question, asked by whoever
 * already knows the page -- `comment-notifications.ts` and
 * `share-notifications.ts` -- and asked again at send time, because a
 * preference stored yesterday must never be the reason a withdrawn share is
 * still announced.
 */

/** An absent row means the catalogue's default, exactly as ADR-023 reads a setting. */
function defaultMode(
  kind: NotificationKind,
  channel: NotificationChannel,
): NotificationDeliveryMode {
  return notificationSupport(kind, channel)?.defaultMode ?? 'OFF';
}

/**
 * What holds for one person and one pair.
 *
 * A pair the catalogue does not describe answers `OFF` rather than throwing: a
 * caller that asks about a combination nothing delivers has found a bug in its
 * own wiring, and the safe reading of "nobody built this" is silence.
 */
export async function resolveNotificationMode(
  prisma: PrismaClient,
  userId: string,
  kind: NotificationKind,
  channel: NotificationChannel,
): Promise<NotificationDeliveryMode> {
  const support = notificationSupport(kind, channel);
  if (support === undefined) return 'OFF';
  if (support.storedOn === 'device') return support.defaultMode;

  const row = await prisma.notificationPreference.findUnique({
    where: { userId_kind_channel: { userId, kind, channel } },
    select: { mode: true },
  });
  return row?.mode ?? support.defaultMode;
}

/**
 * The subset of `userIds` that wants this pair delivered immediately.
 *
 * The order of the input is kept, because a caller that loaded recipients in a
 * meaningful order should not have it shuffled by a lookup. One query for the
 * whole list rather than one per person: a busy page has a thread full of
 * participants, and a round trip each would make the dispatcher's cost grow
 * with how popular the page is.
 */
export async function filterImmediateRecipients(
  prisma: PrismaClient,
  userIds: readonly string[],
  kind: NotificationKind,
  channel: NotificationChannel,
): Promise<string[]> {
  const support = notificationSupport(kind, channel);
  if (support === undefined || userIds.length === 0) return [];
  if (support.storedOn === 'device') {
    // Nothing account-wide to consult: the device rows are the preference, and
    // `push-delivery.ts` reads them when it knows which devices exist.
    return support.defaultMode === 'IMMEDIATE' ? [...userIds] : [];
  }

  const rows = await prisma.notificationPreference.findMany({
    where: { userId: { in: [...userIds] }, kind, channel },
    select: { userId: true, mode: true },
  });
  const stored = new Map(rows.map((row) => [row.userId, row.mode]));
  return userIds.filter((userId) => (stored.get(userId) ?? support.defaultMode) === 'IMMEDIATE');
}

/**
 * A preference without its wording. What an occasion is called depends on who
 * reads it (ADR-062), and this package reaches no message catalogue, so the API
 * adds `label` and `description` in the requester's language.
 */
export type StoredNotificationPreference = Omit<NotificationPreference, 'label' | 'description'>;

/** Everything the account-wide settings page and `exo_notification_preferences` show. */
export async function listNotificationPreferences(
  prisma: PrismaClient,
  userId: string,
): Promise<StoredNotificationPreference[]> {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId },
    select: { kind: true, channel: true, mode: true },
  });
  const stored = new Map(rows.map((row) => [`${row.kind}/${row.channel}`, row.mode]));

  return ACCOUNT_NOTIFICATION_PAIRS.map(({ kind, channel, support }) => ({
    kind,
    channel,
    modes: [...support.modes],
    defaultMode: support.defaultMode,
    mode: stored.get(`${kind}/${channel}`) ?? support.defaultMode,
  }));
}

/**
 * Why a pair cannot be set, or null when it can.
 *
 * Returned as a reason rather than thrown so the API can turn it into its own
 * error code and the same check can be reused by anything else that writes.
 */
export function notificationPreferenceRefusal(
  kind: NotificationKind,
  channel: NotificationChannel,
  mode: NotificationDeliveryMode,
): 'unsupported_pair' | 'device_scoped' | 'unsupported_mode' | null {
  const support = notificationSupport(kind, channel);
  if (support === undefined) return 'unsupported_pair';
  if (support.storedOn === 'device') return 'device_scoped';
  if (!support.modes.includes(mode)) return 'unsupported_mode';
  return null;
}

/**
 * Store one answer, or drop the row when it is the default again.
 *
 * Deleting rather than storing the default is what makes a default that
 * changes later reach everybody who never decided (ADR-023). The caller has
 * already been refused by `notificationPreferenceRefusal` if the pair or the
 * mode is not one this deployment delivers.
 */
export async function setNotificationPreference(
  prisma: PrismaClient,
  userId: string,
  kind: NotificationKind,
  channel: NotificationChannel,
  mode: NotificationDeliveryMode,
): Promise<void> {
  if (mode === defaultMode(kind, channel)) {
    await prisma.notificationPreference.deleteMany({ where: { userId, kind, channel } });
    return;
  }

  await prisma.notificationPreference.upsert({
    where: { userId_kind_channel: { userId, kind, channel } },
    create: { userId, kind, channel, mode },
    update: { mode },
  });
}
