import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';

import { createPrismaClient, type PrismaClient } from './client';
import {
  filterImmediateRecipients,
  listNotificationPreferences,
  notificationPreferenceRefusal,
  resolveNotificationMode,
  setNotificationPreference,
} from './notification-preferences';

/**
 * The layer that decides whether a notification is queued at all (issue #105,
 * ADR-052).
 *
 * Three things are worth proving against a real database rather than a stub.
 * An absent row has to read as the catalogue's default, because that is what
 * makes a default that changes later reach everybody who never decided;
 * setting a preference back to its default has to *delete* the row, or the
 * first sentence stops being true for exactly the people who once touched the
 * switch; and the batch filter has to agree with the single lookup, since one
 * of them decides for a comment thread and the other for a share.
 */
loadDotEnv();

let prisma: PrismaClient;
let userId: string;
let otherId: string;
const userIds: string[] = [];

async function makeUser(name: string): Promise<string> {
  const email = `prefs-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`;
  const user = await prisma.user.create({ data: { email, name, emailVerified: true } });
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  userId = await makeUser('Johanna');
  otherId = await makeUser('Stefan');
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds } } });
});

describe('resolveNotificationMode', () => {
  it('reads an absent row as the catalogue default', async () => {
    expect(await resolveNotificationMode(prisma, userId, 'SHARE', 'EMAIL')).toBe('IMMEDIATE');
  });

  it('reads a stored row', async () => {
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    expect(await resolveNotificationMode(prisma, userId, 'SHARE', 'EMAIL')).toBe('OFF');
  });

  it('answers OFF for a pair this deployment does not deliver', async () => {
    // Nothing mails a calendar reminder, and the safe reading of "nobody built
    // this" is silence rather than an exception in a dispatcher.
    expect(await resolveNotificationMode(prisma, userId, 'CALENDAR', 'EMAIL')).toBe('OFF');
  });

  it('does not consult the account for a device-scoped pair', async () => {
    expect(await resolveNotificationMode(prisma, userId, 'COMMENT', 'PUSH')).toBe('IMMEDIATE');
  });
});

describe('setNotificationPreference', () => {
  it('deletes the row when the answer is the default again', async () => {
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'IMMEDIATE');

    expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(0);
    expect(await resolveNotificationMode(prisma, userId, 'SHARE', 'EMAIL')).toBe('IMMEDIATE');
  });

  it('keeps one row per person, occasion and channel', async () => {
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    expect(await prisma.notificationPreference.count({ where: { userId } })).toBe(1);
  });

  it('leaves everybody else alone', async () => {
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    expect(await resolveNotificationMode(prisma, otherId, 'SHARE', 'EMAIL')).toBe('IMMEDIATE');
  });
});

describe('filterImmediateRecipients', () => {
  it('keeps the order it was given and drops whoever switched off', async () => {
    await setNotificationPreference(prisma, otherId, 'SHARE', 'EMAIL', 'OFF');
    expect(await filterImmediateRecipients(prisma, [otherId, userId], 'SHARE', 'EMAIL')).toEqual([
      userId,
    ]);
  });

  it('answers an empty list without asking the database', async () => {
    expect(await filterImmediateRecipients(prisma, [], 'SHARE', 'EMAIL')).toEqual([]);
  });
});

describe('notificationPreferenceRefusal', () => {
  it('names why a pair cannot be stored', () => {
    expect(notificationPreferenceRefusal('SHARE', 'EMAIL', 'IMMEDIATE')).toBeNull();
    expect(notificationPreferenceRefusal('CALENDAR', 'EMAIL', 'OFF')).toBe('unsupported_pair');
    expect(notificationPreferenceRefusal('COMMENT', 'PUSH', 'OFF')).toBe('device_scoped');
    expect(notificationPreferenceRefusal('SHARE', 'EMAIL', 'DAILY_DIGEST')).toBe(
      'unsupported_mode',
    );
  });
});

describe('listNotificationPreferences', () => {
  it('describes every account-wide pair, answered or not', async () => {
    const rows = await listNotificationPreferences(prisma, userId);
    expect(rows.map((row) => `${row.kind}/${row.channel}`)).toEqual(['SHARE/EMAIL']);
    expect(rows[0]).toMatchObject({ mode: 'IMMEDIATE', defaultMode: 'IMMEDIATE' });
    expect(rows[0]?.modes).toEqual(['OFF', 'IMMEDIATE']);
    expect(rows[0]?.label.length).toBeGreaterThan(0);
  });

  it('shows the stored answer once there is one', async () => {
    await setNotificationPreference(prisma, userId, 'SHARE', 'EMAIL', 'OFF');
    const rows = await listNotificationPreferences(prisma, userId);
    expect(rows[0]?.mode).toBe('OFF');
  });
});
