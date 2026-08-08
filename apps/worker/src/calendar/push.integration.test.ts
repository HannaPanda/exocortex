import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DavClient, type FetchLike } from '@exocortex/calendar';
import { loadDotEnv } from '@exocortex/config';
import { type CalendarLinkPropertyMap, parseCalendarLinkPropertyMap } from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

import { pushLink } from './push';

loadDotEnv();

const logger: Logger = createLogger({ name: 'calendar-push-test', level: 'silent' });
const NOW = new Date('2026-08-08T12:00:00.000Z');

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

/**
 * Stands in for the row query and the document detail route.
 *
 * Rows are real `document` rows: `calendar_object_state.rowDocumentId` is a
 * foreign key, so an invented id would fail on the constraint instead of on the
 * behaviour under test.
 */
function fakeApi(rows: Map<string, TestRow>): {
  client: ExocortexApiClient;
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  const client: ExocortexApiClient = {
    async request<T>(input: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: unknown;
      responseSchema: { parse: (value: unknown) => T };
    }): Promise<T> {
      calls.push({ method: input.method, path: input.path });

      if (input.path.endsWith('/rows/query')) {
        return input.responseSchema.parse({
          rows: [...rows.values()]
            .filter((row) => row.archivedAt === null)
            .map((row) => ({
              document: documentSummary(row),
              values: row.values.map((entry) => ({ ...entry })),
            })),
          nextCursor: null,
        });
      }

      const rowId = /\/api\/documents\/([^/]+)$/.exec(input.path)?.[1] ?? '';
      const row = rows.get(rowId);
      if (input.method === 'GET' && row !== undefined) {
        return input.responseSchema.parse(documentSummary(row));
      }
      throw new Error(`unexpected call ${input.method} ${input.path}`);
    },
    upload: () => {
      throw new Error('not used');
    },
  };
  return { client, calls };
}

function documentSummary(row: TestRow) {
  return {
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
    orderKey: 'a0',
    createdById: userId,
    updatedById: userId,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archivedAt: row.archivedAt,
  };
}

interface DavCall {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
}

/**
 * A CalDAV server that stores objects and answers reads out of that store, so a
 * write and the read that follows it see the same calendar.
 */
function davServer(options: {
  objects?: Map<string, { etag: string; ics: string }>;
  writeStatus?: number;
}): { dav: DavClient; calls: DavCall[]; objects: Map<string, { etag: string; ics: string }> } {
  const objects = options.objects ?? new Map<string, { etag: string; ics: string }>();
  const calls: DavCall[] = [];
  let version = 100;

  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, url, body: init.body, headers: init.headers });

    if (init.method === 'REPORT') {
      const hrefs = [...(init.body ?? '').matchAll(/<href>([^<]+)<\/href>/g)].map(
        (match) => match[1] ?? '',
      );
      const found = hrefs
        .map((href) => ({ href, object: objects.get(href) }))
        .filter((entry): entry is { href: string; object: { etag: string; ics: string } } =>
          entry.object !== undefined,
        );
      return {
        status: 207,
        text: async () => multigetBody(found),
        headers: { get: () => null },
      };
    }

    if (init.method === 'PUT') {
      const status = options.writeStatus ?? (objects.has(path) ? 204 : 201);
      if (status < 300) {
        version += 1;
        objects.set(path, { etag: `"v${version}"`, ics: init.body ?? '' });
      }
      const etag = objects.get(path)?.etag ?? null;
      return { status, text: async () => '', headers: { get: () => etag } };
    }

    if (init.method === 'DELETE') {
      const status = options.writeStatus ?? 204;
      if (status < 300) objects.delete(path);
      return { status, text: async () => '', headers: { get: () => null } };
    }

    throw new Error(`unexpected ${init.method} ${url}`);
  };

  return {
    dav: new DavClient({
      credentials: { baseUrl: 'https://dav.test/', username: 'me@test.org', password: 'pw' },
      logger,
      fetchImpl,
    }),
    calls,
    objects,
  };
}

function multigetBody(entries: { href: string; object: { etag: string; ics: string } }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  ${entries
    .map(
      (entry) => `<response><href>${entry.href}</href>
    <propstat><prop><getetag>${entry.object.etag}</getetag>
      <c:calendar-data>${entry.object.ics.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</c:calendar-data>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>`,
    )
    .join('\n  ')}
</multistatus>`;
}

/** A body as a server stores it, alarm included. */
function remoteIcs(uid: string, summary: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mailbox.org//CalDAV//DE',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'DTSTART:20260820T080000Z',
    'DTEND:20260820T090000Z',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = generateOrderKey(null, null);
  const workspace = await prisma.workspace.create({
    data: { name: 'Kalender-Push-Test', slug: `cal-push-${suffix}-${process.pid}` },
  });
  workspaceId = workspace.id;
  const user = await prisma.user.create({
    data: { name: 'Test', email: `cal-push-${suffix}-${process.pid}@test.invalid` },
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

let linkCounter = 0;

async function createLink(component = 'VEVENT'): Promise<{
  id: string;
  remoteHref: string;
  component: string;
  documentId: string;
  propertyMap: CalendarLinkPropertyMap;
}> {
  const account = await prisma.calendarAccount.create({
    data: {
      workspaceId,
      userId,
      provider: 'CALDAV',
      displayName: 'Test',
      username: `push+${(linkCounter += 1)}@test.org`,
      credentialRef: 'TEST_CALDAV_PASSWORD',
    },
  });
  const link = await prisma.calendarLink.create({
    data: {
      accountId: account.id,
      remoteHref: '/caldav/main/',
      remoteDisplayName: 'Kalender',
      component,
      documentId: collectionId,
      propertyMap,
      direction: 'BOTH',
    },
  });
  return {
    id: link.id,
    remoteHref: link.remoteHref,
    component: link.component,
    documentId: link.documentId,
    propertyMap,
  };
}

/** A real row document, so the state's foreign key resolves. */
async function addRow(
  rows: Map<string, TestRow>,
  title: string,
  values: { propertyId: string; value: unknown }[],
): Promise<TestRow> {
  const document = await prisma.document.create({
    data: {
      workspaceId,
      parentId: collectionId,
      type: 'PAGE',
      title,
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
    },
  });
  const row: TestRow = { id: document.id, title, values, archivedAt: null };
  rows.set(row.id, row);
  return row;
}

function span(start: string, end: string | null, allDay = false) {
  return { propertyId: propertyMap.date!, value: { start, end, allDay } };
}

describe('pushLink', () => {
  it('creates a calendar object for a row that has none yet', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Zahnarzt', [
      span('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z'),
      { propertyId: propertyMap.location!, value: 'Praxis Mitte' },
    ]);
    const server = davServer({});

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ created: 1, updated: 0, conflicts: 0 });
    const put = server.calls.find((call) => call.method === 'PUT');
    // `If-None-Match: *`, so a path that is already taken fails instead of
    // overwriting whatever sits there.
    expect(put?.headers['if-none-match']).toBe('*');
    expect(put?.body).toContain('SUMMARY:Zahnarzt');
    expect(put?.body).toContain('DTSTART:20260820T080000Z');
    expect(put?.body).toContain('LOCATION:Praxis Mitte');

    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, rowDocumentId: row.id },
    });
    // Born here, and therefore the one kind of object this sync may rewrite.
    expect(state?.origin).toBe('LOCAL');
    expect(state?.etag).toBe('"v101"');
    expect(state?.lastPushedHash).not.toBeNull();
  });

  it('writes nothing on a second pass, because the row still matches the hash', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    await addRow(rows, 'Zahnarzt', [span('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z')]);
    const server = davServer({});
    const first = { prisma, client: fakeApi(rows).client, dav: server.dav, logger, link, now: NOW };
    await pushLink(first);

    const second = davServer({ objects: server.objects });
    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: second.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ created: 0, updated: 0 });
    // Not one request: the hash says both sides already agree.
    expect(second.calls).toEqual([]);
  });

  it('patches the existing object when the row changed, keeping the alarm', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Zahnarzt', [
      span('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z'),
    ]);
    const objects = new Map([
      ['/caldav/main/j.ics', { etag: '"1"', ics: remoteIcs('j@test', 'Zahnarzt') }],
    ]);
    await prisma.calendarObjectState.create({
      data: {
        linkId: link.id,
        remoteHref: '/caldav/main/j.ics',
        icsUid: 'j@test',
        rowDocumentId: row.id,
        etag: '"1"',
        origin: 'REMOTE',
        lastPushedHash: 'stale-hash',
      },
    });
    const server = davServer({ objects });

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ updated: 1, created: 0, conflicts: 0 });
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('https://dav.test/caldav/main/j.ics');
    // Conditional on the version that was actually read.
    expect(put?.headers['if-match']).toBe('"1"');
    // Patched, not rebuilt: the reminder someone's phone depends on survives.
    expect(put?.body).toContain('BEGIN:VALARM');
    expect(put?.body).toContain('DTSTART:20260820T080000Z');

    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, rowDocumentId: row.id },
    });
    expect(state?.lastPushedHash).not.toBe('stale-hash');
    expect(state?.etag).toBe('"v101"');
  });

  it('never rewrites an invitation', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Kickoff, verschoben', [
      span('2026-09-01T09:00:00.000Z', '2026-09-01T10:00:00.000Z'),
    ]);
    await prisma.calendarObjectState.create({
      data: {
        linkId: link.id,
        remoteHref: '/caldav/main/k.ics',
        icsUid: 'k@test',
        rowDocumentId: row.id,
        etag: '"1"',
        origin: 'REMOTE',
        // The organizer owns this appointment. Writing a new time would put an
        // ITIP counter-proposal on the wire that nobody asked for.
        organizer: 'chef@example.com',
        lastPushedHash: 'stale-hash',
      },
    });
    const server = davServer({});

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(server.calls).toEqual([]);
  });

  it('never rewrites a series, whose row holds one occurrence and not the rule', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Standup', [
      span('2026-08-10T09:00:00.000Z', '2026-08-10T10:00:00.000Z'),
    ]);
    await prisma.calendarObjectState.create({
      data: {
        linkId: link.id,
        remoteHref: '/caldav/main/l.ics',
        icsUid: 'l@test',
        rowDocumentId: row.id,
        etag: '"1"',
        origin: 'REMOTE',
        recurrenceIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        lastPushedHash: 'stale-hash',
      },
    });
    const server = davServer({});

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ updated: 0, skipped: 1 });
    expect(server.calls).toEqual([]);
  });

  it('skips a row that names no date, because that is not an appointment', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    await addRow(rows, 'Unbenannt', []);
    const server = davServer({});

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(server.calls).toEqual([]);
  });

  it('deletes an object it created once its row is archived', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Abgesagt', [
      span('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z'),
    ]);
    const server = davServer({});
    await pushLink({ prisma, client: fakeApi(rows).client, dav: server.dav, logger, link, now: NOW });

    row.archivedAt = NOW.toISOString();
    await prisma.document.update({ where: { id: row.id }, data: { archivedAt: NOW } });

    const second = davServer({ objects: server.objects });
    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: second.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ deleted: 1 });
    expect(second.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(second.objects.size).toBe(0);
    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, icsUid: { not: '' }, rowDocumentId: null },
    });
    expect(state?.deletedAt).not.toBeNull();
  });

  it('leaves a remote appointment on the calendar when its row is archived', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Fremder Termin', [
      span('2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z'),
    ]);
    row.archivedAt = NOW.toISOString();
    await prisma.document.update({ where: { id: row.id }, data: { archivedAt: NOW } });
    await prisma.calendarObjectState.create({
      data: {
        linkId: link.id,
        remoteHref: '/caldav/main/m.ics',
        icsUid: 'm@test',
        rowDocumentId: row.id,
        etag: '"1"',
        origin: 'REMOTE',
      },
    });
    const server = davServer({
      objects: new Map([['/caldav/main/m.ics', { etag: '"1"', ics: remoteIcs('m@test', 'Fremd') }]]),
    });

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    // Tidying a table is not the same as cancelling an appointment.
    expect(result).toMatchObject({ deleted: 0 });
    expect(server.calls).toEqual([]);
    expect(server.objects.size).toBe(1);
  });

  it('counts a refused precondition as a conflict and writes nothing', async () => {
    const link = await createLink();
    const rows = new Map<string, TestRow>();
    const row = await addRow(rows, 'Zahnarzt, neu', [
      span('2026-08-20T10:00:00.000Z', '2026-08-20T11:00:00.000Z'),
    ]);
    await prisma.calendarObjectState.create({
      data: {
        linkId: link.id,
        remoteHref: '/caldav/main/n.ics',
        icsUid: 'n@test',
        rowDocumentId: row.id,
        etag: '"1"',
        origin: 'LOCAL',
        lastPushedHash: 'stale-hash',
      },
    });
    // 412: the phone got there first. Our body was built on a version that no
    // longer exists, so nothing may be written.
    const server = davServer({
      objects: new Map([['/caldav/main/n.ics', { etag: '"1"', ics: remoteIcs('n@test', 'Alt') }]]),
      writeStatus: 412,
    });

    const result = await pushLink({
      prisma,
      client: fakeApi(rows).client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ updated: 0, conflicts: 1 });
    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, rowDocumentId: row.id },
    });
    // The hash is untouched, so the next pass tries again against the newer version.
    expect(state?.lastPushedHash).toBe('stale-hash');
  });

  it('does nothing at all for a VTODO link', async () => {
    const link = await createLink('VTODO');
    const rows = new Map<string, TestRow>();
    await addRow(rows, 'Aufgabe', [span('2026-08-20T08:00:00.000Z', null)]);
    const api = fakeApi(rows);
    const server = davServer({});

    const result = await pushLink({
      prisma,
      client: api.client,
      dav: server.dav,
      logger,
      link,
      now: NOW,
    });

    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0 });
    // Not even the rows are read: pushing a todo as an event would be worse than
    // not pushing it at all.
    expect(api.calls).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});
