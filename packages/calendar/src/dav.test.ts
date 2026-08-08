import { describe, expect, it } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { DavClient, type FetchLike } from './dav-client';
import { listCollections } from './discovery';
import { listObjects, syncCollection, toIcalUtc } from './sync';

const logger = createLogger({ name: 'calendar-test', level: 'silent' });

/**
 * A fake server that answers from a script and records what it was asked.
 *
 * The response bodies reproduce the namespace mess a real CalDAV server
 * produces: `D:` prefixes on some elements, a default `xmlns` on others, and a
 * `calendar-home-set` whose child `href` carries a different prefix than its
 * parent. That mix is exactly what the parser has to survive.
 */
function fakeServer(script: { status?: number; body: string }[]): {
  fetchImpl: FetchLike;
  calls: { method: string; url: string; body?: string; depth?: string }[];
} {
  const calls: { method: string; url: string; body?: string; depth?: string }[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body, depth: init.headers.depth });
    const step = script[index] ?? script[script.length - 1];
    index += 1;
    return { status: step?.status ?? 207, text: async () => step?.body ?? '' };
  };
  return { fetchImpl, calls };
}

function client(script: { status?: number; body: string }[]) {
  const server = fakeServer(script);
  return {
    client: new DavClient({
      credentials: {
        baseUrl: 'https://dav.example.org/',
        username: 'user@example.org',
        password: 'app-password',
      },
      logger,
      fetchImpl: server.fetchImpl,
    }),
    calls: server.calls,
  };
}

const COLLECTIONS_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/caldav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/main/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/><CAL:calendar/></D:resourcetype>
      <D:displayname>Kalender</D:displayname>
      <D:sync-token>tok-1</D:sync-token>
      <CAL:supported-calendar-component-set><CAL:comp name="VEVENT"/></CAL:supported-calendar-component-set>
      <CS:getctag>ctag-1</CS:getctag>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/generated/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/><CAL:calendar/></D:resourcetype>
      <D:displayname>Geburtstage</D:displayname>
      <CAL:supported-calendar-component-set><CAL:comp name="VEVENT"/></CAL:supported-calendar-component-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
    <D:propstat><D:prop><D:sync-token/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/tasks/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/><CAL:calendar/></D:resourcetype>
      <D:displayname>Aufgaben</D:displayname>
      <D:sync-token>tok-t</D:sync-token>
      <CAL:supported-calendar-component-set><CAL:comp name="VTODO"/></CAL:supported-calendar-component-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/schedule-inbox/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/><CAL:schedule-inbox/></D:resourcetype>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

describe('listCollections', () => {
  it('keeps the calendars and drops the home collection itself', async () => {
    const { client: dav } = client([{ body: COLLECTIONS_BODY }]);
    const collections = await listCollections(dav, '/caldav/');
    expect(collections.map((entry) => entry.href)).toEqual([
      '/caldav/main/',
      '/caldav/generated/',
      '/caldav/tasks/',
      '/caldav/schedule-inbox/',
    ]);
  });

  it('reads names and component sets across namespace prefixes', async () => {
    const { client: dav } = client([{ body: COLLECTIONS_BODY }]);
    const collections = await listCollections(dav, '/caldav/');
    expect(collections[0]).toMatchObject({
      displayName: 'Kalender',
      components: ['VEVENT'],
      ctag: 'ctag-1',
      isScheduleCollection: false,
    });
    expect(collections[2]?.components).toEqual(['VTODO']);
  });

  it('marks a collection whose sync-token came back 404 as not incrementally syncable', async () => {
    const { client: dav } = client([{ body: COLLECTIONS_BODY }]);
    const collections = await listCollections(dav, '/caldav/');
    // The generated birthday calendar. Treating this as syncable would mean
    // never seeing a change in it.
    expect(collections[1]?.supportsSyncCollection).toBe(false);
    expect(collections[0]?.supportsSyncCollection).toBe(true);
  });

  it('flags the scheduling collection, where invitations arrive', async () => {
    const { client: dav } = client([{ body: COLLECTIONS_BODY }]);
    const collections = await listCollections(dav, '/caldav/');
    expect(collections[3]?.isScheduleCollection).toBe(true);
  });
});

describe('syncCollection', () => {
  const DELTA = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/caldav/main/a.ics</href>
    <propstat><prop><getetag>"etag-a"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/caldav/main/gone.ics</href>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
  <sync-token>tok-2</sync-token>
</multistatus>`;

  it('separates changes from deletions and returns the next token', async () => {
    const { client: dav } = client([{ body: DELTA }]);
    const delta = await syncCollection(dav, '/caldav/main/', 'tok-1');
    expect(delta.changed).toEqual([{ href: '/caldav/main/a.ics', etag: '"etag-a"' }]);
    // A deletion is a bare status on the response, with no propstat at all.
    expect(delta.removed).toEqual(['/caldav/main/gone.ics']);
    expect(delta.syncToken).toBe('tok-2');
    expect(delta.resetRequired).toBe(false);
  });

  it('sends an empty token for the initial round', async () => {
    const { client: dav, calls } = client([{ body: DELTA }]);
    await syncCollection(dav, '/caldav/main/', null);
    expect(calls[0]?.body).toContain('<sync-token></sync-token>');
    expect(calls[0]?.method).toBe('REPORT');
  });

  it('asks for a full re-read when the server rejects the token', async () => {
    const { client: dav } = client([{ status: 403, body: '<error xmlns="DAV:"><valid-sync-token/></error>' }]);
    const delta = await syncCollection(dav, '/caldav/main/', 'ancient');
    // Reported, not thrown: retrying the same token can never succeed, and
    // treating it as "nothing changed" is how a mirror silently drifts.
    expect(delta.resetRequired).toBe(true);
    expect(delta.syncToken).toBeNull();
  });
});

describe('listObjects', () => {
  it('lists the objects of a collection without the collection itself', async () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/caldav/generated/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/caldav/generated/b1.ics</D:href>
    <D:propstat><D:prop><D:getetag>"e1"</D:getetag><D:resourcetype/></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    const { client: dav } = client([{ body }]);
    expect(await listObjects(dav, '/caldav/generated/')).toEqual([
      { href: '/caldav/generated/b1.ics', etag: '"e1"' },
    ]);
  });
});

describe('DavClient', () => {
  it('resolves an href against the origin, not against the request path', () => {
    const { client: dav } = client([{ body: '' }]);
    // A calendar-home-set of /caldav/ discovered while asking about
    // /principals/users/3 must not become /principals/caldav/.
    expect(dav.resolve('/caldav/')).toBe('https://dav.example.org/caldav/');
  });

  it('reports the status on a failed request and never echoes the password', async () => {
    const { client: dav } = client([{ status: 401, body: 'Unauthorized: app-password rejected' }]);
    await expect(listObjects(dav, '/caldav/main/')).rejects.toMatchObject({
      name: 'CalDavError',
      status: 401,
    });
  });

  it('sends Basic auth rather than putting credentials in the URL', async () => {
    const server = fakeServer([{ body: '<multistatus xmlns="DAV:"/>' }]);
    const dav = new DavClient({
      credentials: { baseUrl: 'https://dav.example.org/', username: 'u@e.org', password: 'p' },
      logger,
      fetchImpl: server.fetchImpl,
    });
    await listObjects(dav, '/caldav/main/');
    expect(server.calls[0]?.url).toBe('https://dav.example.org/caldav/main/');
  });
});

describe('toIcalUtc', () => {
  it('formats the only shape a time-range filter accepts', () => {
    expect(toIcalUtc(new Date('2026-08-01T00:00:00.000Z'))).toBe('20260801T000000Z');
  });
});
