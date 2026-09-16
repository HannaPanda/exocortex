import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadDotEnv } from '@exocortex/config';
import { type CalendarLinkPropertyMap, parseCalendarLinkPropertyMap } from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

import { type ReminderNotifier } from './notifier';
import { type ReminderSchedule } from './reminder-time';
import { sendDueReminders } from './reminders';

loadDotEnv();

const logger: Logger = createLogger({ name: 'calendar-reminder-test', level: 'silent' });
const SCHEDULE: ReminderSchedule = {
  leadMinutes: 30,
  allDayHour: 9,
  timeZone: 'Europe/Berlin',
};
/** 13:32Z, so a 14:00Z appointment is 28 minutes away and therefore due. */
const NOW = new Date('2026-08-20T13:32:00.000Z');
const START = '2026-08-20T14:00:00.000Z';

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;
let collectionId: string;
let propertyMap: CalendarLinkPropertyMap;

interface TestRow {
  id: string;
  title: string;
  values: { propertyId: string; value: unknown }[];
  archivedAt: string | null;
}

/** Answers the row query only; the sweep needs nothing else from the API. */
function fakeApi(rows: Map<string, TestRow>): (userId: string) => ExocortexApiClient {
  const client: ExocortexApiClient = {
    async request<T>(input: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      responseSchema: { parse: (value: unknown) => T };
    }): Promise<T> {
      if (!input.path.endsWith('/rows/query')) {
        throw new Error(`unexpected call ${input.method} ${input.path}`);
      }
      return input.responseSchema.parse({
        rows: [...rows.values()]
          .filter((row) => row.archivedAt === null)
          .map((row) => ({
            document: {
              id: row.id,
              workspaceId,
              parentId: collectionId,
              type: 'PAGE',
              title: row.title,
              icon: null,
              iconColor: null,
              layout: 'narrow',
              coverAttachmentId: null,
              coverPosition: 50,
              overviewMode: 'off',
              orderKey: 'a0',
              createdById: userId,
              updatedById: userId,
              createdAt: NOW.toISOString(),
              updatedAt: NOW.toISOString(),
              archivedAt: row.archivedAt,
            },
            values: row.values.map((entry) => ({ ...entry })),
          })),
        nextCursor: null,
      });
    },
    upload: () => {
      throw new Error('not used');
    },
  };
  return () => client;
}

function fakeNotifier(options: { fail?: boolean } = {}): ReminderNotifier & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async send(body: string): Promise<void> {
      if (options.fail === true) throw new Error('delivery refused');
      sent.push(body);
    },
  };
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = generateOrderKey(null, null);
  const workspace = await prisma.workspace.create({
    data: { name: 'Kalender-Erinnerungs-Test', slug: `cal-rem-${suffix}-${process.pid}` },
  });
  workspaceId = workspace.id;
  const user = await prisma.user.create({
    data: { name: 'Test', email: `cal-rem-${suffix}-${process.pid}@test.invalid` },
  });
  userId = user.id;
  const collection = await prisma.document.create({
    data: {
      workspaceId,
      type: 'COLLECTION',
      title: 'Kalender',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
    },
  });
  collectionId = collection.id;

  const date = await prisma.databaseProperty.create({
    data: {
      documentId: collectionId,
      type: 'DATE',
      name: 'Zeitraum',
      orderKey: generateOrderKey(null, null),
      config: { includeTime: true, isRange: true, timeZone: null },
    },
  });
  const location = await prisma.databaseProperty.create({
    data: {
      documentId: collectionId,
      type: 'TEXT',
      name: 'Ort',
      orderKey: generateOrderKey(date.orderKey, null),
    },
  });
  propertyMap = parseCalendarLinkPropertyMap({ date: date.id, location: location.id });
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

let counter = 0;

/** A fresh account, link, row and state per test. */
async function scenario(
  options: {
    component?: string;
    start?: string;
    end?: string | null;
    allDay?: boolean;
    remindedFor?: Date | null;
    archived?: boolean;
    location?: string | null;
  } = {},
): Promise<{
  rows: Map<string, TestRow>;
  stateId: string;
  linkId: string;
  rowId: string;
}> {
  const index = (counter += 1);
  const account = await prisma.calendarAccount.create({
    data: {
      workspaceId,
      userId,
      provider: 'CALDAV',
      displayName: 'Test',
      username: `remind+${index}@test.org`,
      credentialRef: 'TEST_CALDAV_PASSWORD',
    },
  });
  const link = await prisma.calendarLink.create({
    data: {
      accountId: account.id,
      remoteHref: `/caldav/main-${index}/`,
      remoteDisplayName: 'Kalender',
      component: options.component ?? 'VEVENT',
      documentId: collectionId,
      propertyMap,
    },
  });

  const start = options.start ?? START;
  const document = await prisma.document.create({
    data: {
      workspaceId,
      parentId: collectionId,
      type: 'PAGE',
      title: 'Zahnarzt',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
      ...(options.archived === true ? { archivedAt: NOW } : {}),
    },
  });
  const values: { propertyId: string; value: unknown }[] = [
    {
      propertyId: propertyMap.date!,
      value: {
        start,
        end: options.end === undefined ? '2026-08-20T15:00:00.000Z' : options.end,
        allDay: options.allDay ?? false,
      },
    },
  ];
  if (options.location != null) {
    values.push({ propertyId: propertyMap.location!, value: options.location });
  }

  const rows = new Map<string, TestRow>([
    [
      document.id,
      {
        id: document.id,
        title: 'Zahnarzt',
        values,
        archivedAt: options.archived === true ? NOW.toISOString() : null,
      },
    ],
  ]);

  const state = await prisma.calendarObjectState.create({
    data: {
      linkId: link.id,
      remoteHref: `/caldav/main-${index}/a.ics`,
      icsUid: `remind-${index}@test`,
      rowDocumentId: document.id,
      etag: '"1"',
      origin: 'REMOTE',
      occurrenceStart: new Date(start),
      remindedFor: options.remindedFor ?? null,
    },
  });

  return { rows, stateId: state.id, linkId: link.id, rowId: document.id };
}

function run(
  rows: Map<string, TestRow>,
  notifier: ReminderNotifier,
  now: Date = NOW,
): Promise<{ sent: number; pending: number; failed: number }> {
  return sendDueReminders({
    prisma,
    apiClientFor: fakeApi(rows),
    notifier,
    logger,
    // Resolved per workspace since issue #52; this suite has exactly one.
    scheduleFor: async () => SCHEDULE,
    appUrl: 'https://exocortex.test',
    now,
  });
}

describe('sendDueReminders', () => {
  it('sends a due reminder and records which occurrence it announced', async () => {
    const { rows, stateId } = await scenario({ location: 'Praxis Mitte' });
    const notifier = fakeNotifier();

    const result = await run(rows, notifier);

    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(notifier.sent[0]).toContain('🔔 In 28 Minuten: Zahnarzt');
    expect(notifier.sent[0]).toContain('16:00 bis 17:00 Uhr · Praxis Mitte');
    // The link points at the row, so the reminder is one tap from the page.
    expect(notifier.sent[0]).toContain(
      `https://exocortex.test/arbeitsbereich/${workspaceId}/seite/`,
    );

    const state = await prisma.calendarObjectState.findUnique({ where: { id: stateId } });
    expect(state?.remindedFor?.toISOString()).toBe(START);
  });

  it('stays silent on a second pass', async () => {
    const { rows } = await scenario();
    const first = fakeNotifier();
    await run(rows, first);

    const second = fakeNotifier();
    const result = await run(rows, second);

    expect(result.sent).toBe(0);
    expect(second.sent).toEqual([]);
  });

  it('sends again once the appointment moved, because a new time is news', async () => {
    const { rows, stateId } = await scenario();
    await run(rows, fakeNotifier());

    // The appointment moves half an hour later; both the row and the mirrored
    // start follow, exactly as a pull would leave them.
    const moved = '2026-08-20T14:30:00.000Z';
    const row = [...rows.values()][0]!;
    row.values = [
      { propertyId: propertyMap.date!, value: { start: moved, end: null, allDay: false } },
    ];
    await prisma.calendarObjectState.update({
      where: { id: stateId },
      data: { occurrenceStart: new Date(moved) },
    });

    const notifier = fakeNotifier();
    const result = await run(rows, notifier, new Date('2026-08-20T14:05:00.000Z'));

    expect(result.sent).toBe(1);
    expect(notifier.sent[0]).toContain('In 25 Minuten');
  });

  it('leaves an appointment alone until its moment comes', async () => {
    const { rows } = await scenario({ start: '2026-08-20T18:00:00.000Z', end: null });
    const notifier = fakeNotifier();

    const result = await run(rows, notifier);

    expect(result).toMatchObject({ sent: 0, pending: 1 });
    expect(notifier.sent).toEqual([]);
  });

  it('announces an all-day appointment at the configured hour', async () => {
    const { rows } = await scenario({
      start: '2026-08-20T00:00:00.000Z',
      end: '2026-08-21T00:00:00.000Z',
      allDay: true,
    });
    const notifier = fakeNotifier();

    // 07:00Z is 09:00 in Berlin during summer time.
    const result = await run(rows, notifier, new Date('2026-08-20T07:00:00.000Z'));

    expect(result.sent).toBe(1);
    expect(notifier.sent[0]).toContain('🔔 Heute: Zahnarzt');
    expect(notifier.sent[0]).toContain('Ganztägig');
  });

  it('never announces a todo, whose date is a deadline and not an appointment', async () => {
    const { rows } = await scenario({ component: 'VTODO' });
    const notifier = fakeNotifier();

    const result = await run(rows, notifier);

    expect(result).toMatchObject({ sent: 0, pending: 0 });
    expect(notifier.sent).toEqual([]);
  });

  it('keeps a failed delivery due, so the next pass tries again', async () => {
    const { rows, stateId } = await scenario();

    const result = await run(rows, fakeNotifier({ fail: true }));

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    const state = await prisma.calendarObjectState.findUnique({ where: { id: stateId } });
    expect(state?.remindedFor).toBeNull();

    // And the retry succeeds without anything having to be reset by hand.
    const notifier = fakeNotifier();
    expect((await run(rows, notifier)).sent).toBe(1);
  });

  it('says nothing about a row that was archived', async () => {
    const { rows } = await scenario({ archived: true });
    const notifier = fakeNotifier();

    const result = await run(rows, notifier);

    expect(result.sent).toBe(0);
    expect(notifier.sent).toEqual([]);
  });
});
