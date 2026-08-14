import { CalDavError, type DavClient } from './dav-client';
import {
  type CalendarObject,
  type CalendarObjectRef,
  type SyncDelta,
  type TimeRange,
} from './types';
import { asArray, childNames, isSuccessStatus, nodeAt, statusCode, textAt } from './xml';

/** Multiget is chunked: one request per this many hrefs. */
const MULTIGET_CHUNK = 50;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * One incremental sync round over a collection.
 *
 * `syncToken` null asks for the initial, full listing; the token the server
 * returns is what makes the next round cheap. Verified against mailbox.org: the
 * first round returned 4 resources and a token, the second round with that
 * token returned 0.
 *
 * Only `href` and `etag` come back, never bodies. Deciding *which* of the
 * changed resources actually needs fetching is the caller's job, because the
 * caller is the one holding the etags it already knows.
 */
export async function syncCollection(
  client: DavClient,
  collectionHref: string,
  syncToken: string | null,
): Promise<SyncDelta> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<sync-collection xmlns="DAV:">
  <sync-token>${syncToken === null ? '' : escapeXml(syncToken)}</sync-token>
  <sync-level>1</sync-level>
  <prop><getetag/></prop>
</sync-collection>`;

  let response;
  try {
    response = await client.request({
      method: 'REPORT',
      url: collectionHref,
      depth: '0',
      body,
      timeoutMs: 60_000,
    });
  } catch (error) {
    // A token the server has forgotten is not an error the caller can fix by
    // retrying: RFC 6578 says answer 403 with `valid-sync-token`, and some
    // servers use 409. Either way the only way forward is a full re-read, so it
    // is reported as data rather than thrown.
    if (error instanceof CalDavError && (error.status === 403 || error.status === 409)) {
      return { changed: [], removed: [], syncToken: null, resetRequired: true };
    }
    throw error;
  }

  const changed: CalendarObjectRef[] = [];
  const removed: string[] = [];

  for (const entry of asArray(nodeAt(response.xml, 'multistatus', 'response'))) {
    const href = textAt(entry, 'href');
    if (href === null) continue;

    // A deletion is reported as a bare `<status>` on the response, without any
    // propstat. Reading only the propstats would drop deletions entirely.
    const responseStatus = statusCode(textAt(entry, 'status'));
    if (responseStatus === 404 || responseStatus === 410) {
      removed.push(href);
      continue;
    }

    const etag = asArray(nodeAt(entry, 'propstat'))
      .filter((propstat) => isSuccessStatus(textAt(propstat, 'status')))
      .map((propstat) => textAt(propstat, 'prop', 'getetag'))
      .find((value): value is string => value !== null);
    changed.push({ href, etag: etag ?? null });
  }

  return {
    changed,
    removed,
    syncToken: textAt(response.xml, 'multistatus', 'sync-token'),
    resetRequired: false,
  };
}

/**
 * Lists every object in a collection with its etag, for collections the server
 * gives no sync token for.
 *
 * mailbox.org's generated "Geburtstage" calendar is exactly that case. There is
 * no cheaper way there than reading the whole list and diffing it locally, which
 * is why such a collection should be polled far less often than the others.
 */
export async function listObjects(
  client: DavClient,
  collectionHref: string,
): Promise<CalendarObjectRef[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><getetag/><resourcetype/></prop></propfind>`;
  const response = await client.request({
    method: 'PROPFIND',
    url: collectionHref,
    depth: '1',
    body,
    timeoutMs: 60_000,
  });

  const refs: CalendarObjectRef[] = [];
  for (const entry of asArray(nodeAt(response.xml, 'multistatus', 'response'))) {
    const href = textAt(entry, 'href');
    if (href === null) continue;
    const propstats = asArray(nodeAt(entry, 'propstat')).filter((propstat) =>
      isSuccessStatus(textAt(propstat, 'status')),
    );
    // The collection itself comes back too and is not an object in it.
    const kinds = propstats.flatMap((propstat) =>
      childNames(nodeAt(propstat, 'prop', 'resourcetype')),
    );
    if (kinds.includes('collection')) continue;

    const etag = propstats
      .map((propstat) => textAt(propstat, 'prop', 'getetag'))
      .find((value): value is string => value !== null);
    refs.push({ href, etag: etag ?? null });
  }
  return refs;
}

/**
 * Fetches the bodies of specific objects, chunked.
 *
 * One request per object would be a round-trip per appointment; one request for
 * a whole year would be a response big enough to time out. `MULTIGET_CHUNK`
 * splits the difference, and the chunks run sequentially on purpose: this is
 * someone else's mail server, and a parallel burst per calendar is how a sync
 * gets itself rate-limited.
 */
export async function fetchObjects(
  client: DavClient,
  collectionHref: string,
  hrefs: readonly string[],
): Promise<CalendarObject[]> {
  const objects: CalendarObject[] = [];
  for (let index = 0; index < hrefs.length; index += MULTIGET_CHUNK) {
    const chunk = hrefs.slice(index, index + MULTIGET_CHUNK);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <prop><getetag/><c:calendar-data/></prop>
  ${chunk.map((href) => `<href>${escapeXml(href)}</href>`).join('\n  ')}
</c:calendar-multiget>`;
    const response = await client.request({
      method: 'REPORT',
      url: collectionHref,
      depth: '1',
      body,
      timeoutMs: 90_000,
    });
    objects.push(...readCalendarData(response.xml));
  }
  return objects;
}

/**
 * Fetches every object overlapping a window, letting the server expand
 * recurrences into the range.
 *
 * This is how a yearly birthday whose DTSTART is in 2025 is found in a 2026
 * window: the server evaluates the RRULE. Confirmed against mailbox.org.
 */
export async function fetchObjectsInRange(
  client: DavClient,
  collectionHref: string,
  range: TimeRange,
  component: 'VEVENT' | 'VTODO' = 'VEVENT',
): Promise<CalendarObject[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <prop><getetag/><c:calendar-data/></prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="${component}">
        <c:time-range start="${toIcalUtc(range.start)}" end="${toIcalUtc(range.end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
  const response = await client.request({
    method: 'REPORT',
    url: collectionHref,
    depth: '1',
    body,
    timeoutMs: 90_000,
  });
  return readCalendarData(response.xml);
}

/** Every object in a `calendar-query`/`calendar-multiget` multistatus body. */
function readCalendarData(xml: Record<string, unknown> | null): CalendarObject[] {
  const objects: CalendarObject[] = [];
  for (const entry of asArray(nodeAt(xml as never, 'multistatus', 'response'))) {
    const href = textAt(entry, 'href');
    if (href === null) continue;
    for (const propstat of asArray(nodeAt(entry, 'propstat'))) {
      if (!isSuccessStatus(textAt(propstat, 'status'))) continue;
      const ics = textAt(propstat, 'prop', 'calendar-data');
      if (ics === null) continue;
      objects.push({ href, etag: textAt(propstat, 'prop', 'getetag'), ics });
    }
  }
  return objects;
}

/** `20260801T000000Z`, the only date form a time-range filter accepts. */
export function toIcalUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}
