import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DavClient, type FetchLike } from '@exocortex/calendar';
import { loadDotEnv } from '@exocortex/config';
import { type CalendarLinkPropertyMap, parseCalendarLinkPropertyMap } from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';

import { pullLink } from './pull';

loadDotEnv();

const logger: Logger = createLogger({ name: 'calendar-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;
let collectionId: string;
let propertyMap: CalendarLinkPropertyMap;

/** Rows the fake API "created", so a pull's effect is inspectable. */
interface RecordedRow {
  id: string;
  title: string;
  values: { propertyId: string; value: unknown }[];
  archived: boolean;
}

/**
 * Stands in for `apps/api`'s row routes.
 *
 * It creates a *real* `document` row rather than inventing an id, because
 * `calendar_object_state.rowDocumentId` is a foreign key: a fake that only
 * returned a plausible-looking id would make the sync fail on the constraint,
 * which is exactly the failure this test is supposed to catch in the sync and
 * not in itself.
 */
function fakeApi(rows: Map<string, RecordedRow>): {
  client: ExocortexApiClient;
  calls: { method: string; path: string }[];
} {
  const calls: { method: string; path: string }[] = [];
  const client: ExocortexApiClient = {
    // The generic signature is implemented rather than cast away: the schema
    // carries the return type, so `parse` already produces a `T` and no `any`
    // is needed (CLAUDE.md rule 7). `responseSchema` is typed structurally so
    // this test file does not have to depend on zod.
    async request<T>(input: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      path: string;
      body?: unknown;
      responseSchema: { parse: (value: unknown) => T };
    }): Promise<T> {
      calls.push({ method: input.method, path: input.path });
      const body = (input.body ?? {}) as {
        title?: string;
        values?: { propertyId: string; value: unknown }[];
      };

      if (input.method === 'POST' && input.path.endsWith('/rows')) {
        const created = await prisma.document.create({
          data: {
            workspaceId,
            parentId: collectionId,
            type: 'PAGE',
            title: body.title ?? 'Unbenannt',
            orderKey: generateOrderKey(null, null),
            createdById: userId,
            updatedById: userId,
          },
        });
        rows.set(created.id, {
          id: created.id,
          title: created.title,
          values: body.values ?? [],
          archived: false,
        });
        return input.responseSchema.parse({
          document: documentSummary(created.id, created.title),
          values: (body.values ?? []).map((entry) => ({ ...entry })),
        });
      }

      const rowId = /\/api\/documents\/([^/]+)/.exec(input.path)?.[1] ?? '';
      const row = rows.get(rowId);
      if (row === undefined) throw new Error(`unknown row ${rowId}`);

      // The real API refuses to write to an archived document, and the sync's
      // whole "the row is gone" branch hangs off that refusal. A fake that
      // happily wrote anyway would report every such path as working.
      if (row.archived && !input.path.endsWith('/archive')) {
        throw new ExocortexApiError('document_archived', 'Die Seite ist archiviert.', 409, null);
      }

      if (input.path.endsWith('/values')) {
        row.values = body.values ?? [];
        return input.responseSchema.parse({
          document: documentSummary(row.id, row.title),
          values: row.values.map((entry) => ({ ...entry })),
        });
      }
      if (input.path.endsWith('/archive')) {
        row.archived = true;
        await prisma.document.update({
          where: { id: row.id },
          data: { archivedAt: new Date() },
        });
        return input.responseSchema.parse(documentSummary(row.id, row.title));
      }
      if (input.method === 'PATCH') {
        row.title = body.title ?? row.title;
        await prisma.document.update({ where: { id: row.id }, data: { title: row.title } });
        return input.responseSchema.parse(documentSummary(row.id, row.title));
      }
      throw new Error(`unexpected call ${input.method} ${input.path}`);
    },
    upload: () => {
      throw new Error('not used');
    },
  };
  return { client, calls };
}

function documentSummary(id: string, title: string) {
  return {
    id,
    workspaceId,
    parentId: collectionId,
    type: 'PAGE',
    title,
    icon: null,
    iconColor: null,
    layout: 'narrow',
    coverAttachmentId: null,
    coverPosition: 50,
    overviewMode: 'off',
    orderKey: 'a0',
    createdById: userId,
    updatedById: userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  };
}

/** A CalDAV server that answers from a queue of bodies. */
function davFor(responses: { status?: number; body: string }[]): DavClient {
  let index = 0;
  const fetchImpl: FetchLike = async () => {
    const step = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return { status: step?.status ?? 207, text: async () => step?.body ?? '' };
  };
  return new DavClient({
    credentials: { baseUrl: 'https://dav.test/', username: 'me@test.org', password: 'pw' },
    logger,
    fetchImpl,
  });
}

function icsFor(uid: string, summary: string, start: string, end: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function deltaBody(entries: { href: string; etag: string }[], token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  ${entries
    .map(
      (entry) => `<response><href>${entry.href}</href>
    <propstat><prop><getetag>${entry.etag}</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>`,
    )
    .join('\n  ')}
  <sync-token>${token}</sync-token>
</multistatus>`;
}

function multigetBody(objects: { href: string; etag: string; ics: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  ${objects
    .map(
      (object) => `<response><href>${object.href}</href>
    <propstat><prop><getetag>${object.etag}</getetag>
      <c:calendar-data>${object.ics.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</c:calendar-data>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>`,
    )
    .join('\n  ')}
</multistatus>`;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const suffix = generateOrderKey(null, null);
  const workspace = await prisma.workspace.create({
    data: { name: 'Kalender-Test', slug: `cal-test-${suffix}-${process.pid}` },
  });
  workspaceId = workspace.id;
  const user = await prisma.user.create({
    data: { name: 'Test', email: `cal-${suffix}-${process.pid}@test.invalid` },
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
  const recurrence = await prisma.databaseProperty.create({
    data: {
      documentId: collectionId,
      type: 'TEXT',
      name: 'Wiederholung',
      orderKey: generateOrderKey(location.orderKey, null),
    },
  });
  propertyMap = parseCalendarLinkPropertyMap({
    date: date.id,
    location: location.id,
    recurrence: recurrence.id,
  });
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

/**
 * A fresh account and link per test, so a sync token or a piece of object state
 * can never leak from one case into the next. The username is varied because
 * `(workspaceId, provider, username)` is unique -- adding the same mailbox twice
 * would sync every event twice, which is exactly what that constraint prevents.
 */
let linkCounter = 0;

async function createLink(): Promise<{
  id: string;
  remoteHref: string;
  component: string;
  documentId: string;
  syncToken: string | null;
  supportsSyncCollection: boolean;
  propertyMap: CalendarLinkPropertyMap;
}> {
  const account = await prisma.calendarAccount.create({
    data: {
      workspaceId,
      userId,
      provider: 'CALDAV',
      displayName: 'Test',
      username: `me+${(linkCounter += 1)}@test.org`,
      credentialRef: 'TEST_CALDAV_PASSWORD',
    },
  });
  const link = await prisma.calendarLink.create({
    data: {
      accountId: account.id,
      remoteHref: '/caldav/main/',
      remoteDisplayName: 'Kalender',
      component: 'VEVENT',
      documentId: collectionId,
      propertyMap,
    },
  });
  return {
    id: link.id,
    remoteHref: link.remoteHref,
    component: link.component,
    documentId: link.documentId,
    syncToken: null,
    supportsSyncCollection: true,
    propertyMap,
  };
}

describe('pullLink', () => {
  it('creates a row per calendar object and writes the span', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const api = fakeApi(rows);
    const dav = davFor([
      { body: deltaBody([{ href: '/caldav/main/a.ics', etag: '"1"' }], 'tok-1') },
      {
        body: multigetBody([
          {
            href: '/caldav/main/a.ics',
            etag: '"1"',
            ics: icsFor('a@test', 'Zahnarzt', '20260820T080000Z', '20260820T090000Z'),
          },
        ]),
      },
    ]);

    const result = await pullLink({
      prisma,
      client: api.client,
      dav,
      logger,
      link,
      selfAddresses: ['me@test.org'],
      full: false,
      canPush: false,
    });

    expect(result.created).toBe(1);
    expect(result.syncToken).toBe('tok-1');
    const row = [...rows.values()][0];
    expect(row?.title).toBe('Zahnarzt');
    expect(row?.values.find((value) => value.propertyId === propertyMap.date)?.value).toEqual({
      start: '2026-08-20T08:00:00.000Z',
      end: '2026-08-20T09:00:00.000Z',
      allDay: false,
    });
  });

  it('remembers the object so a second pass with the same etag fetches no body', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const first = fakeApi(rows);
    await pullLink({
      prisma,
      client: first.client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/b.ics', etag: '"1"' }], 'tok-1') },
        {
          body: multigetBody([
            {
              href: '/caldav/main/b.ics',
              etag: '"1"',
              ics: icsFor('b@test', 'Termin', '20260820T080000Z', '20260820T090000Z'),
            },
          ]),
        },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    // Second pass: the server reports the same etag, so nothing needs fetching
    // and no row is touched. This is what keeps a routine sync cheap.
    const second = fakeApi(rows);
    const result = await pullLink({
      prisma,
      client: second.client,
      dav: davFor([{ body: deltaBody([{ href: '/caldav/main/b.ics', etag: '"1"' }], 'tok-2') }]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(second.calls).toEqual([]);
  });

  it('updates the existing row when the etag moved instead of creating a second one', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const first = fakeApi(rows);
    await pullLink({
      prisma,
      client: first.client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/c.ics', etag: '"1"' }], 'tok-1') },
        {
          body: multigetBody([
            {
              href: '/caldav/main/c.ics',
              etag: '"1"',
              ics: icsFor('c@test', 'Alter Titel', '20260820T080000Z', '20260820T090000Z'),
            },
          ]),
        },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    const second = fakeApi(rows);
    const result = await pullLink({
      prisma,
      client: second.client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/c.ics', etag: '"2"' }], 'tok-2') },
        {
          body: multigetBody([
            {
              href: '/caldav/main/c.ics',
              etag: '"2"',
              ics: icsFor('c@test', 'Neuer Titel', '20260820T100000Z', '20260820T110000Z'),
            },
          ]),
        },
      ]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0];
    expect(row?.title).toBe('Neuer Titel');
    expect(row?.values.find((value) => value.propertyId === propertyMap.date)?.value).toMatchObject(
      {
        start: '2026-08-20T10:00:00.000Z',
      },
    );
  });

  it('archives the row and leaves a tombstone when the object is gone', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/d.ics', etag: '"1"' }], 'tok-1') },
        {
          body: multigetBody([
            {
              href: '/caldav/main/d.ics',
              etag: '"1"',
              ics: icsFor('d@test', 'Abgesagt', '20260820T080000Z', '20260820T090000Z'),
            },
          ]),
        },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    const removal = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response><href>/caldav/main/d.ics</href><status>HTTP/1.1 404 Not Found</status></response>
  <sync-token>tok-2</sync-token>
</multistatus>`;
    const result = await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([{ body: removal }]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result.archived).toBe(1);
    // Archived, not deleted: the row is a page and may carry someone's notes.
    expect([...rows.values()][0]?.archived).toBe(true);
    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, remoteHref: '/caldav/main/d.ics' },
    });
    expect(state?.deletedAt).not.toBeNull();
    expect(state?.rowDocumentId).toBeNull();
  });

  it('falls back to a full read when the server rejects the sync token', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const result = await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        // 403 with valid-sync-token: the token is too old to continue from.
        { status: 403, body: '<error xmlns="DAV:"><valid-sync-token/></error>' },
        { body: deltaBody([{ href: '/caldav/main/e.ics', etag: '"1"' }], 'tok-fresh') },
        {
          body: multigetBody([
            {
              href: '/caldav/main/e.ics',
              etag: '"1"',
              ics: icsFor('e@test', 'Wieder da', '20260820T080000Z', '20260820T090000Z'),
            },
          ]),
        },
      ]),
      logger,
      link: { ...link, syncToken: 'ancient' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result.wasFullRead).toBe(true);
    expect(result.created).toBe(1);
    expect(result.syncToken).toBe('tok-fresh');
  });

  it('records the organizer, which is what marks an event as not ours to rewrite', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const invitation = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:f@test',
      'SUMMARY:Kickoff',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'ORGANIZER:mailto:chef@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@test.org',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/f.ics', etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ href: '/caldav/main/f.ics', etag: '"1"', ics: invitation }]) },
      ]),
      logger,
      link,
      selfAddresses: ['me@test.org'],
      full: false,
      canPush: false,
    });

    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, remoteHref: '/caldav/main/f.ics' },
    });
    expect(state?.organizer).toBe('chef@example.com');
    expect(state?.partStat).toBe('ACCEPTED');
    // Everything a pull discovers was created elsewhere.
    expect(state?.origin).toBe('REMOTE');
  });

  it('mirrors a series at its next occurrence and describes the rule in German', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    // Starts in 2020, so the date the series *began* is far in the past. That
    // date used to end up in the table, which is the one date it never happens.
    const yearly = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:g@test',
      'SUMMARY:Jahrestag',
      'DTSTART;VALUE=DATE:20200817',
      'DTEND;VALUE=DATE:20200818',
      'RRULE:FREQ=YEARLY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/g.ics', etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ href: '/caldav/main/g.ics', etag: '"1"', ics: yearly }]) },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    const row = [...rows.values()][0];
    const span = row?.values.find((value) => value.propertyId === propertyMap.date)?.value as {
      start: string;
    };
    // Same day of the year, but never a year that is already over.
    expect(span.start.slice(4)).toBe('-08-17T00:00:00.000Z');
    expect(Number(span.start.slice(0, 4))).toBeGreaterThanOrEqual(new Date().getUTCFullYear());
    expect(row?.values.find((value) => value.propertyId === propertyMap.recurrence)?.value).toBe(
      'jährlich',
    );

    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, remoteHref: '/caldav/main/g.ics' },
    });
    // The body is cached because the occurrence has to be recomputed as time
    // passes, long after the last change to the object.
    expect(state?.recurrenceIcs).toContain('RRULE:FREQ=YEARLY');
    expect(state?.occurrenceStart?.toISOString()).toBe(span.start);
  });

  it('moves a stale series onto its current occurrence without fetching a body', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const weekly = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:h@test',
      'SUMMARY:Standup',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/h.ics', etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ href: '/caldav/main/h.ics', etag: '"1"', ics: weekly }]) },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    // Rewind the mirror to the first occurrence: what a row looks like once a
    // week has gone by without the appointment changing.
    const rowId = [...rows.keys()][0]!;
    rows.get(rowId)!.values = [
      {
        propertyId: propertyMap.date!,
        value: {
          start: '2026-06-01T09:00:00.000Z',
          end: '2026-06-01T10:00:00.000Z',
          allDay: false,
        },
      },
    ];
    await prisma.calendarObjectState.updateMany({
      where: { linkId: link.id, remoteHref: '/caldav/main/h.ics' },
      data: { occurrenceStart: new Date('2026-06-01T09:00:00.000Z') },
    });

    const second = fakeApi(rows);
    const result = await pullLink({
      prisma,
      client: second.client,
      // A single response: the etag is unchanged, so a body must never be
      // requested. The rule is expanded from the cached copy instead.
      dav: davFor([{ body: deltaBody([{ href: '/caldav/main/h.ics', etag: '"1"' }], 'tok-2') }]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result).toMatchObject({ created: 0, updated: 0, unchanged: 1, refreshed: 1 });
    const span = rows.get(rowId)?.values.find((value) => value.propertyId === propertyMap.date)
      ?.value as { start: string; end: string };
    // The occurrence now current: its end is still ahead of us.
    expect(Date.parse(span.end)).toBeGreaterThan(Date.now());
    expect(new Date(span.start).getUTCDay()).toBe(1);
  });

  it('recreates an archived row on a read-only link, because a mirror lost a page', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const object = {
      href: '/caldav/main/j.ics',
      ics: icsFor('j@test', 'Termin', '20260820T080000Z', '20260820T090000Z'),
    };
    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: object.href, etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ ...object, etag: '"1"' }]) },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    const rowId = [...rows.keys()][0]!;
    rows.get(rowId)!.archived = true;
    await prisma.document.update({ where: { id: rowId }, data: { archivedAt: new Date() } });

    const result = await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: object.href, etag: '"2"' }], 'tok-2') },
        { body: multigetBody([{ ...object, etag: '"2"' }]) },
      ]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    expect(result).toMatchObject({ created: 1, pendingDelete: 0 });
    expect(rows.size).toBe(2);
  });

  it('leaves an archived row alone on a link that pushes, so the delete can happen', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const object = {
      href: '/caldav/main/k.ics',
      ics: icsFor('k@test', 'Selbst angelegt', '20260820T080000Z', '20260820T090000Z'),
    };
    await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: object.href, etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ ...object, etag: '"1"' }]) },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: true,
    });

    // Born here, which is what makes an archived row a cancellation rather than a
    // mirror that lost a page.
    await prisma.calendarObjectState.updateMany({
      where: { linkId: link.id, remoteHref: object.href },
      data: { origin: 'LOCAL' },
    });
    const rowId = [...rows.keys()][0]!;
    rows.get(rowId)!.archived = true;
    await prisma.document.update({ where: { id: rowId }, data: { archivedAt: new Date() } });

    const result = await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: object.href, etag: '"2"' }], 'tok-2') },
        { body: multigetBody([{ ...object, etag: '"2"' }]) },
      ]),
      logger,
      link: { ...link, syncToken: 'tok-1' },
      selfAddresses: [],
      full: false,
      canPush: true,
    });

    // No second row, and the pointer is kept: the pull runs first, so recreating
    // the row here would erase the cancellation before the push ever saw it.
    expect(result).toMatchObject({ created: 0, pendingDelete: 1 });
    expect(rows.size).toBe(1);
    const state = await prisma.calendarObjectState.findFirst({
      where: { linkId: link.id, remoteHref: object.href },
    });
    expect(state?.rowDocumentId).toBe(rowId);
  });

  it('folds an override into the series instead of creating a second row', async () => {
    const link = await createLink();
    const rows = new Map<string, RecordedRow>();
    const withOverride = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:i@test',
      'SUMMARY:Standup',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:i@test',
      'SUMMARY:Standup (verschoben)',
      'RECURRENCE-ID:20260608T090000Z',
      'DTSTART:20260608T140000Z',
      'DTEND:20260608T150000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const result = await pullLink({
      prisma,
      client: fakeApi(rows).client,
      dav: davFor([
        { body: deltaBody([{ href: '/caldav/main/i.ics', etag: '"1"' }], 'tok-1') },
        { body: multigetBody([{ href: '/caldav/main/i.ics', etag: '"1"', ics: withOverride }]) },
      ]),
      logger,
      link,
      selfAddresses: [],
      full: false,
      canPush: false,
    });

    // One appointment, one row. The moved instance is a modification of the
    // series, not a second entry in the calendar.
    expect(result).toMatchObject({ created: 1, overrides: 1 });
    expect(rows.size).toBe(1);
  });
});
