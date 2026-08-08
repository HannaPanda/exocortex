import { type DavClient } from './dav-client';
import { type CalendarCollection } from './types';
import { asArray, childNames, isSuccessStatus, nodeAt, textAt } from './xml';

const CURRENT_USER_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>`;

const CALENDAR_HOME_SET = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <prop><c:calendar-home-set/><displayname/></prop>
</propfind>`;

const COLLECTION_PROPS = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <prop>
    <resourcetype/>
    <displayname/>
    <sync-token/>
    <c:supported-calendar-component-set/>
    <cs:getctag/>
  </prop>
</propfind>`;

/**
 * Walks the standard three-step CalDAV discovery: the well-known entry point
 * names the principal, the principal names the calendar home, the home lists
 * the calendars.
 *
 * Not shortcut to "just PROPFIND /caldav/": the home is server-specific
 * (mailbox.org answers `/caldav/`, other servers answer paths containing the
 * account id), and hardcoding it breaks the moment a second provider is added.
 */
export async function discoverCalendars(client: DavClient): Promise<CalendarCollection[]> {
  const principal = await discoverPrincipal(client);
  const home = await discoverCalendarHome(client, principal);
  return listCollections(client, home);
}

export async function discoverPrincipal(client: DavClient): Promise<string> {
  const response = await client.request({
    method: 'PROPFIND',
    url: '/',
    depth: '0',
    body: CURRENT_USER_PRINCIPAL,
  });
  const href = firstPropstatText(response.xml, 'current-user-principal', 'href');
  if (href === null) {
    throw new Error('CalDAV discovery: server returned no current-user-principal');
  }
  return href;
}

export async function discoverCalendarHome(client: DavClient, principalHref: string): Promise<string> {
  const response = await client.request({
    method: 'PROPFIND',
    url: principalHref,
    depth: '0',
    body: CALENDAR_HOME_SET,
  });
  const href = firstPropstatText(response.xml, 'calendar-home-set', 'href');
  if (href === null) {
    throw new Error(`CalDAV discovery: principal ${principalHref} returned no calendar-home-set`);
  }
  return href;
}

/**
 * The calendars directly under `homeHref`.
 *
 * Depth 1 includes the home itself and the scheduling inbox/outbox. The home is
 * dropped (it is a plain collection), the scheduling collections are kept but
 * flagged: they are where invitations arrive, which is what tells an incoming
 * event from a locally created one.
 */
export async function listCollections(client: DavClient, homeHref: string): Promise<CalendarCollection[]> {
  const response = await client.request({
    method: 'PROPFIND',
    url: homeHref,
    depth: '1',
    body: COLLECTION_PROPS,
  });

  const collections: CalendarCollection[] = [];
  for (const entry of asArray(nodeAt(response.xml, 'multistatus', 'response'))) {
    const href = textAt(entry, 'href');
    if (href === null) continue;

    const propstats = asArray(nodeAt(entry, 'propstat')).filter((propstat) =>
      isSuccessStatus(textAt(propstat, 'status')),
    );
    const kinds = propstats.flatMap((propstat) => childNames(nodeAt(propstat, 'prop', 'resourcetype')));
    const isScheduleCollection =
      kinds.includes('schedule-inbox') || kinds.includes('schedule-outbox');
    if (!kinds.includes('calendar') && !isScheduleCollection) continue;

    const prop = propstats.map((propstat) => nodeAt(propstat, 'prop')).find((node) => node !== undefined);
    const components = asArray(nodeAt(prop, 'supported-calendar-component-set', 'comp'))
      .map((comp) => textAt(comp, '@name'))
      .filter((name): name is string => name !== null);

    collections.push({
      href,
      // A calendar without a display name is legal; its path is the only label
      // left, and showing that beats showing an empty string.
      displayName: textAt(prop, 'displayname')?.trim() || href,
      components,
      // Presence, not content: some servers return an empty element, which is
      // still a promise that sync-collection works here.
      supportsSyncCollection: nodeAt(prop, 'sync-token') !== undefined,
      ctag: textAt(prop, 'getctag'),
      isScheduleCollection,
    });
  }
  return collections;
}

/**
 * Reads one property out of the first successful `propstat` of the first
 * `response`. Depth-0 requests have exactly one of each, but a server may still
 * split properties across several propstats with different statuses, so the
 * failing ones are skipped rather than read as empty.
 */
function firstPropstatText(
  xml: Record<string, unknown> | null,
  ...path: string[]
): string | null {
  for (const entry of asArray(nodeAt(xml as never, 'multistatus', 'response'))) {
    for (const propstat of asArray(nodeAt(entry, 'propstat'))) {
      if (!isSuccessStatus(textAt(propstat, 'status'))) continue;
      const value = textAt(propstat, 'prop', ...path);
      if (value !== null) return value;
    }
  }
  return null;
}
