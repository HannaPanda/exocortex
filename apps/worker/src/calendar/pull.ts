import {
  type CalendarObjectRef,
  type DavClient,
  fetchObjects,
  listObjects,
  parseCalendarObject,
  type ParsedCalendarEvent,
  type ParsedCalendarTodo,
  syncCollection,
} from '@exocortex/calendar';
import {
  type CalendarComponent,
  type CalendarLinkPropertyMap,
  type DatabaseRowPropertyValue,
  databaseRowSchema,
  documentSummarySchema,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';

export interface PullLinkInput {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  link: {
    id: string;
    remoteHref: string;
    component: string;
    documentId: string;
    syncToken: string | null;
    supportsSyncCollection: boolean;
    propertyMap: CalendarLinkPropertyMap;
  };
  /** Matched against ATTENDEE to read our own participation status. */
  selfAddresses: readonly string[];
  /** Ignore the stored token and re-read everything. */
  full: boolean;
}

export interface PullLinkResult {
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  /** Recurrence overrides seen but not yet mirrored; see the note below. */
  skippedOverrides: number;
  syncToken: string | null;
  /** True when the server made us re-read everything. */
  wasFullRead: boolean;
}

/**
 * Reads one remote collection into its mirror database.
 *
 * Strictly one-directional: nothing here ever writes to the calendar server.
 * Rows are written through the REST API with a service token for the owning
 * human, never straight into the database, so a mirrored appointment gets the
 * same outbox event, realtime emit and search indexing as a hand-typed row
 * (ADR-014) -- and lands in the open editor session rather than behind it.
 */
export async function pullLink(input: PullLinkInput): Promise<PullLinkResult> {
  const { prisma, dav, link, logger } = input;

  const useToken = !input.full && link.supportsSyncCollection && link.syncToken !== null;
  let refs: CalendarObjectRef[];
  let removed: string[] = [];
  let syncToken: string | null = link.syncToken;
  let wasFullRead = !useToken;

  if (useToken) {
    const delta = await syncCollection(dav, link.remoteHref, link.syncToken);
    if (delta.resetRequired) {
      // The server forgot the token. Retrying it can never work, so the only
      // correct move is a full re-read; treating it as "nothing changed" is how
      // a mirror silently drifts away from the calendar.
      logger.warn('Calendar sync token rejected, falling back to a full read', {
        linkId: link.id,
      });
      const fresh = await readEverything(dav, link);
      refs = fresh.refs;
      syncToken = fresh.syncToken;
      wasFullRead = true;
    } else {
      refs = delta.changed;
      removed = delta.removed;
      syncToken = delta.syncToken ?? link.syncToken;
    }
  } else {
    const fresh = await readEverything(dav, link);
    refs = fresh.refs;
    syncToken = fresh.syncToken;
  }

  const states = await prisma.calendarObjectState.findMany({ where: { linkId: link.id } });
  const stateByHref = new Map(states.map((state) => [state.remoteHref, state]));

  // Only bodies whose version actually moved are fetched. This is the whole
  // point of carrying etags: a routine run over an unchanged calendar costs one
  // REPORT and no bodies at all.
  const toFetch = refs.filter((ref) => {
    const known = stateByHref.get(ref.href);
    if (known === undefined || known.rowDocumentId === null) return true;
    return ref.etag === null || known.etag !== ref.etag;
  });
  const unchanged = refs.length - toFetch.length;

  const objects = await fetchObjects(dav, link.remoteHref, toFetch.map((ref) => ref.href));

  const result: PullLinkResult = {
    created: 0,
    updated: 0,
    unchanged,
    archived: 0,
    skippedOverrides: 0,
    syncToken,
    wasFullRead,
  };

  for (const object of objects) {
    const parsed = parseCalendarObject(object.ics, { selfAddresses: input.selfAddresses });
    const component = link.component as CalendarComponent;

    if (component === 'VTODO') {
      const todo = parsed.todos[0];
      if (todo === undefined) continue;
      await upsertRow({
        ...input,
        object,
        uid: todo.uid,
        title: todo.summary,
        organizer: null,
        partStat: null,
        remoteUpdatedAt: todo.lastModified,
        values: todoValues(link.propertyMap, todo),
        result,
      });
      continue;
    }

    // A recurring series and its per-instance overrides share one object. The
    // series (no RECURRENCE-ID) is the row; an override is a modification of one
    // occurrence, not a second appointment, and mirroring it as its own row would
    // show a duplicate. Counted so the gap is visible rather than silent.
    const master = parsed.events.find((event) => event.recurrenceId === null);
    result.skippedOverrides += parsed.events.filter((event) => event.recurrenceId !== null).length;
    if (master === undefined) continue;

    await upsertRow({
      ...input,
      object,
      uid: master.uid,
      title: master.summary,
      organizer: master.organizer,
      partStat: master.partStat,
      remoteUpdatedAt: master.lastModified,
      values: eventValues(link.propertyMap, master),
      result,
    });
  }

  for (const href of removed) {
    const known = stateByHref.get(href);
    if (known === undefined) continue;
    if (known.rowDocumentId !== null) {
      await archiveRow(input.client, known.rowDocumentId, logger);
      result.archived += 1;
    }
    // Tombstone rather than delete: with remote creation allowed, a missing
    // object is not proof it never existed, and a later full read would happily
    // recreate what the user deleted.
    await prisma.calendarObjectState.update({
      where: { id: known.id },
      data: { deletedAt: new Date(), rowDocumentId: null },
    });
  }

  return result;
}

/**
 * Everything in the collection, with a fresh token when the server offers one.
 *
 * Two shapes, because not every collection supports both: a `sync-collection`
 * with an empty token gives the full listing *and* a token to continue from,
 * while a collection without token support (mailbox.org's generated
 * "Geburtstage") only answers a plain PROPFIND.
 */
async function readEverything(
  dav: DavClient,
  link: { remoteHref: string; supportsSyncCollection: boolean },
): Promise<{ refs: CalendarObjectRef[]; syncToken: string | null }> {
  if (link.supportsSyncCollection) {
    const initial = await syncCollection(dav, link.remoteHref, null);
    return { refs: initial.changed, syncToken: initial.syncToken };
  }
  return { refs: await listObjects(dav, link.remoteHref), syncToken: null };
}

function eventValues(
  map: CalendarLinkPropertyMap,
  event: ParsedCalendarEvent,
): DatabaseRowPropertyValue[] {
  const values: DatabaseRowPropertyValue[] = [];
  if (map.date !== null) {
    values.push({
      propertyId: map.date,
      value: { start: event.start, end: event.end, allDay: event.allDay },
    });
  }
  if (map.location !== null) values.push({ propertyId: map.location, value: event.location });
  if (map.description !== null) {
    values.push({ propertyId: map.description, value: event.description });
  }
  if (map.organizer !== null) values.push({ propertyId: map.organizer, value: event.organizer });
  if (map.participation !== null) {
    values.push({ propertyId: map.participation, value: event.partStat });
  }
  if (map.recurrence !== null) values.push({ propertyId: map.recurrence, value: event.rrule });
  return values;
}

function todoValues(
  map: CalendarLinkPropertyMap,
  todo: ParsedCalendarTodo,
): DatabaseRowPropertyValue[] {
  const values: DatabaseRowPropertyValue[] = [];
  if (map.due !== null) {
    // A todo's due date is a deadline, not a span, so the DATE property is
    // written as a plain instant even though it is configured as a range.
    values.push({
      propertyId: map.due,
      value: todo.due === null ? null : { start: todo.due, end: null, allDay: todo.dueAllDay },
    });
  }
  if (map.status !== null) values.push({ propertyId: map.status, value: todo.status });
  if (map.description !== null) values.push({ propertyId: map.description, value: todo.description });
  return values;
}

/** A calendar object with no SUMMARY still deserves a recognisable row. */
function rowTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? 'Ohne Titel' : trimmed.slice(0, 300);
}

async function upsertRow(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  logger: Logger;
  link: { id: string; documentId: string };
  object: { href: string; etag: string | null };
  uid: string;
  title: string;
  organizer: string | null;
  partStat: string | null;
  remoteUpdatedAt: string | null;
  values: DatabaseRowPropertyValue[];
  result: PullLinkResult;
}): Promise<void> {
  const { prisma, client, link, object } = input;
  const known = await prisma.calendarObjectState.findUnique({
    where: { linkId_remoteHref: { linkId: link.id, remoteHref: object.href } },
  });

  const shared = {
    etag: object.etag,
    icsUid: input.uid,
    organizer: input.organizer,
    partStat: input.partStat,
    remoteUpdatedAt: input.remoteUpdatedAt === null ? null : new Date(input.remoteUpdatedAt),
    lastSeenAt: new Date(),
    // Re-appearing after a remote delete clears the tombstone: the object is
    // demonstrably back.
    deletedAt: null,
  };

  if (known?.rowDocumentId != null) {
    const alive = await updateRow(client, known.rowDocumentId, input.title, input.values, input.logger);
    if (alive) {
      await prisma.calendarObjectState.update({ where: { id: known.id }, data: shared });
      input.result.updated += 1;
      return;
    }
    // The row was deleted or archived in Exocortex. Forget the pointer and fall
    // through to a fresh create, which is what a PULL mirror means.
    await prisma.calendarObjectState.update({
      where: { id: known.id },
      data: { rowDocumentId: null },
    });
  }

  const row = await client.request({
    method: 'POST',
    path: `/api/documents/${link.documentId}/rows`,
    body: { title: rowTitle(input.title), values: input.values },
    responseSchema: databaseRowSchema,
  });

  await prisma.calendarObjectState.upsert({
    where: { linkId_remoteHref: { linkId: link.id, remoteHref: object.href } },
    create: {
      linkId: link.id,
      remoteHref: object.href,
      rowDocumentId: row.document.id,
      // Everything a pull discovers was created somewhere else, which is exactly
      // what makes it not ours to rewrite later.
      origin: 'REMOTE',
      ...shared,
    },
    update: { rowDocumentId: row.document.id, ...shared },
  });
  input.result.created += 1;
}

/** Returns false when the row is gone, so the caller can recreate it. */
async function updateRow(
  client: ExocortexApiClient,
  rowDocumentId: string,
  title: string,
  values: DatabaseRowPropertyValue[],
  logger: Logger,
): Promise<boolean> {
  try {
    await client.request({
      method: 'PATCH',
      path: `/api/documents/${rowDocumentId}`,
      body: { title: rowTitle(title) },
      responseSchema: documentSummarySchema,
    });
    if (values.length > 0) {
      await client.request({
        method: 'PATCH',
        path: `/api/documents/${rowDocumentId}/values`,
        body: { values },
        responseSchema: databaseRowSchema,
      });
    }
    return true;
  } catch (error) {
    if (error instanceof ExocortexApiError && (error.code === 'not_found' || error.code === 'document_archived')) {
      logger.debug('Calendar row is gone, will be recreated', { rowDocumentId });
      return false;
    }
    throw error;
  }
}

/**
 * Archives rather than deletes. The appointment is gone from the calendar, but
 * the row is a page that may carry notes someone wrote on it, and a mirror is
 * not entitled to destroy those.
 */
async function archiveRow(
  client: ExocortexApiClient,
  rowDocumentId: string,
  logger: Logger,
): Promise<void> {
  try {
    await client.request({
      method: 'POST',
      path: `/api/documents/${rowDocumentId}/archive`,
      responseSchema: documentSummarySchema,
    });
  } catch (error) {
    if (error instanceof ExocortexApiError && (error.code === 'not_found' || error.code === 'document_archived')) {
      return;
    }
    logger.warn('Could not archive a removed calendar row', { rowDocumentId });
  }
}
