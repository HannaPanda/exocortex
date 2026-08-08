import { describe, expect, it } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { CalDavError, DavClient, type FetchLike } from './dav-client';
import { calendarObjectHref, deleteCalendarObject, putCalendarObject } from './write';

const logger = createLogger({ name: 'calendar-write-test', level: 'silent' });

interface Call {
  method: string;
  url: string;
  body?: string;
  headers: Record<string, string>;
}

/** A server that answers from a script and records the conditional headers. */
function server(script: { status: number; etag?: string; body?: string }[]): {
  client: DavClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body, headers: init.headers });
    const step = script[index] ?? script[script.length - 1];
    index += 1;
    return {
      status: step?.status ?? 204,
      text: async () => step?.body ?? '',
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? step?.etag ?? null : null) },
    };
  };

  return {
    client: new DavClient({
      credentials: {
        baseUrl: 'https://dav.example.org/',
        username: 'user@example.org',
        password: 'app-password',
      },
      logger,
      fetchImpl,
    }),
    calls,
  };
}

describe('putCalendarObject', () => {
  it('creates with If-None-Match and reports the new etag', async () => {
    const { client, calls } = server([{ status: 201, etag: '"v1"' }]);

    const result = await putCalendarObject(client, {
      href: '/caldav/main/new.ics',
      ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      ifMatch: null,
    });

    expect(result).toEqual({ etag: '"v1"', written: true });
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('https://dav.example.org/caldav/main/new.ics');
    expect(calls[0]?.headers['if-none-match']).toBe('*');
    expect(calls[0]?.headers['if-match']).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBe('text/calendar; charset=utf-8');
  });

  it('replaces with If-Match on the version it read', async () => {
    const { client, calls } = server([{ status: 204, etag: '"v2"' }]);

    const result = await putCalendarObject(client, {
      href: '/caldav/main/known.ics',
      ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      ifMatch: '"v1"',
    });

    expect(result).toEqual({ etag: '"v2"', written: true });
    expect(calls[0]?.headers['if-match']).toBe('"v1"');
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
  });

  it('reports a rejected precondition as "not written" instead of throwing', async () => {
    // 412 means the phone got there first. Retrying the same body would discard
    // whatever it wrote, so this has to reach the caller as a decision.
    const { client } = server([{ status: 412, body: '<error xmlns="DAV:"/>' }]);

    expect(
      await putCalendarObject(client, { href: '/caldav/main/x.ics', ics: 'x', ifMatch: '"old"' }),
    ).toEqual({ etag: null, written: false });
  });

  it('still throws for a real failure', async () => {
    const { client } = server([{ status: 403, body: 'Forbidden' }]);

    await expect(
      putCalendarObject(client, { href: '/caldav/main/x.ics', ics: 'x', ifMatch: null }),
    ).rejects.toBeInstanceOf(CalDavError);
  });

  it('accepts an empty body without trying to parse it as XML', async () => {
    const { client } = server([{ status: 204, body: '' }]);

    await expect(
      putCalendarObject(client, { href: '/caldav/main/x.ics', ics: 'x', ifMatch: null }),
    ).resolves.toMatchObject({ written: true });
  });
});

describe('deleteCalendarObject', () => {
  it('sends If-Match and reports success', async () => {
    const { client, calls } = server([{ status: 204 }]);

    expect(await deleteCalendarObject(client, { href: '/caldav/main/x.ics', ifMatch: '"v1"' })).toBe(
      true,
    );
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.headers['if-match']).toBe('"v1"');
  });

  it('treats an object that is already gone as deleted', async () => {
    // The caller asked for absence, and absence is what it got. Reporting this as
    // a failure would make every pass try the same delete again.
    const { client } = server([{ status: 404, body: 'Not Found' }]);

    expect(await deleteCalendarObject(client, { href: '/caldav/main/x.ics', ifMatch: null })).toBe(
      true,
    );
  });

  it('reports a rejected precondition as "not deleted"', async () => {
    const { client } = server([{ status: 412 }]);

    expect(await deleteCalendarObject(client, { href: '/caldav/main/x.ics', ifMatch: '"old"' })).toBe(
      false,
    );
  });
});

describe('calendarObjectHref', () => {
  it('puts the UID under the collection', () => {
    expect(calendarObjectHref('/caldav/main/', 'abc@exocortex')).toBe(
      '/caldav/main/abc%40exocortex.ics',
    );
  });

  it('adds the missing slash', () => {
    expect(calendarObjectHref('/caldav/main', 'abc')).toBe('/caldav/main/abc.ics');
  });

  it('encodes a UID that would otherwise change the path', () => {
    expect(calendarObjectHref('/caldav/main/', 'a/b')).toBe('/caldav/main/a%2Fb.ics');
  });
});
