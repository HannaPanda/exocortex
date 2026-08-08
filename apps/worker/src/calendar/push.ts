import {
  buildEventIcs,
  type CalendarEventPayload,
  calendarObjectHref,
  type DavClient,
  deleteCalendarObject,
  fetchObjects,
  hashCalendarEventPayload,
  newCalendarUid,
  patchEventIcs,
  putCalendarObject,
} from '@exocortex/calendar';
import {
  type CalendarLinkPropertyMap,
  type DatabaseRow,
  documentSummarySchema,
} from '@exocortex/contracts';
import { type CalendarObjectState, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';

import { readAllRows, readSpan, readText, valueOf } from './rows';

export interface PushLinkInput {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  link: {
    id: string;
    remoteHref: string;
    component: string;
    documentId: string;
    propertyMap: CalendarLinkPropertyMap;
  };
  now: Date;
}

export interface PushLinkResult {
  /** Rows that became a new object on the calendar server. */
  created: number;
  /** Rows whose edit was written into the existing object. */
  updated: number;
  /** Objects removed because the row they mirror was archived. */
  deleted: number;
  /**
   * Rows the sync is deliberately not allowed to write outward: an invitation, a
   * series, a row without a date. Counted rather than logged per row, so a
   * calendar full of invitations does not fill the log every five minutes.
   */
  skipped: number;
  /**
   * Writes the server refused because the object had changed since we read it.
   * Nothing was written; the next pull brings the newer version in.
   */
  conflicts: number;
}

/**
 * Writes local changes of one mirror database back to the calendar server.
 *
 * Runs only for a link whose `direction` allows it, and only for VEVENT. The
 * asymmetry with `pullLink` is on purpose: a pull that goes wrong puts bad rows
 * in Exocortex, while a push that goes wrong damages the calendar a phone and a
 * mail client depend on. So this direction is deliberately narrow.
 *
 * Four things it will never do:
 *
 * * touch an object with an ORGANIZER. That object arrived as an invitation, its
 *   organizer owns the appointment, and rewriting the time would put an ITIP
 *   counter-proposal on the wire without anybody having asked for one.
 * * touch a recurring object. The mirrored row holds *one occurrence* of the
 *   series (see `resolveOccurrence`), so writing the row back would flatten the
 *   whole rule into that single date.
 * * write unconditionally. Every PUT and DELETE carries the etag it read, and a
 *   refused precondition is left for the next pull instead of retried.
 * * delete an object it did not create. Archiving a mirrored row is tidying a
 *   table; deleting somebody's appointment because of it is not what they asked
 *   for. Only an object born here (`origin: LOCAL`) is removed.
 */
export async function pushLink(input: PushLinkInput): Promise<PushLinkResult> {
  const result: PushLinkResult = { created: 0, updated: 0, deleted: 0, skipped: 0, conflicts: 0 };

  // VTODO write-back is its own shape (STATUS, COMPLETED, PERCENT-COMPLETE) and
  // is not part of this direction yet. Silently pushing a todo as an event would
  // be worse than not pushing it.
  if (input.link.component !== 'VEVENT') return result;
  // Without a date column there is no appointment to write, only a title.
  if (input.link.propertyMap.date === null) return result;

  const rows = await readAllRows(input.client, input.link.documentId);
  const states = await input.prisma.calendarObjectState.findMany({
    where: { linkId: input.link.id, deletedAt: null },
  });
  const stateByRow = new Map(
    states
      .filter((state): state is CalendarObjectState & { rowDocumentId: string } =>
        state.rowDocumentId !== null,
      )
      .map((state) => [state.rowDocumentId, state]),
  );

  for (const row of rows) {
    const state = stateByRow.get(row.document.id);
    const payload = payloadFrom(row, input.link.propertyMap, state?.icsUid ?? null);
    if (payload === null) {
      result.skipped += 1;
      continue;
    }

    if (state === undefined) {
      await createRemote({ ...input, payload, rowDocumentId: row.document.id, result });
      continue;
    }
    await updateRemote({ ...input, payload, state, result });
  }

  await deleteVanished({ ...input, liveRowIds: new Set(rows.map((row) => row.document.id)), states, result });

  return result;
}

/**
 * The payload a row describes, or null when it describes no appointment.
 *
 * A row without a start is the normal state of a row somebody has just added and
 * not filled in yet. It is not an appointment, and inventing a date for it would
 * put a phantom entry on the calendar.
 */
function payloadFrom(
  row: DatabaseRow,
  map: CalendarLinkPropertyMap,
  uid: string | null,
): CalendarEventPayload | null {
  const span = readSpan(valueOf(row, map.date));
  if (span === null) return null;

  return {
    uid: uid ?? newCalendarUid(),
    summary: row.document.title,
    description: readText(valueOf(row, map.description)),
    location: readText(valueOf(row, map.location)),
    start: span.start,
    end: span.end,
    allDay: span.allDay,
  };
}

/** A row that no calendar object belongs to yet becomes one. */
async function createRemote(input: {
  prisma: PrismaClient;
  dav: DavClient;
  logger: Logger;
  link: { id: string; remoteHref: string };
  payload: CalendarEventPayload;
  rowDocumentId: string;
  now: Date;
  result: PushLinkResult;
}): Promise<void> {
  const href = calendarObjectHref(input.link.remoteHref, input.payload.uid);
  const ics = buildEventIcs(input.payload, { now: input.now });
  const written = await putCalendarObject(input.dav, { href, ics, ifMatch: null });
  if (!written.written) {
    // `If-None-Match: *` refused: something already sits at that path. Since the
    // UID was generated a moment ago, that is a state we do not understand, and
    // guessing here would overwrite a stranger's object.
    input.logger.warn('Calendar object already exists at a freshly generated path', { href });
    input.result.conflicts += 1;
    return;
  }

  await input.prisma.calendarObjectState.upsert({
    where: { linkId_remoteHref: { linkId: input.link.id, remoteHref: href } },
    create: {
      linkId: input.link.id,
      remoteHref: href,
      icsUid: input.payload.uid,
      rowDocumentId: input.rowDocumentId,
      etag: written.etag,
      // Born in Exocortex, and therefore the one kind of object this sync is
      // entitled to rewrite and to delete later.
      origin: 'LOCAL',
      lastPushedHash: hashCalendarEventPayload(input.payload),
      // The date the row names, so the reminder sweep can see it without asking
      // the API. A locally created appointment deserves a reminder as much as a
      // mirrored one.
      occurrenceStart: new Date(input.payload.start),
      lastSeenAt: input.now,
    },
    update: {
      icsUid: input.payload.uid,
      rowDocumentId: input.rowDocumentId,
      etag: written.etag,
      lastPushedHash: hashCalendarEventPayload(input.payload),
      occurrenceStart: new Date(input.payload.start),
      lastSeenAt: input.now,
      deletedAt: null,
    },
  });
  input.result.created += 1;
}

/** An edited row is written into the object it mirrors, never rebuilt from it. */
async function updateRemote(input: {
  prisma: PrismaClient;
  dav: DavClient;
  logger: Logger;
  link: { id: string; remoteHref: string };
  payload: CalendarEventPayload;
  state: CalendarObjectState;
  now: Date;
  result: PushLinkResult;
}): Promise<void> {
  const { state } = input;

  if (state.organizer !== null || state.recurrenceIcs !== null) {
    input.result.skipped += 1;
    return;
  }

  const hash = hashCalendarEventPayload(input.payload);
  // The hash is what the last agreed-on version looked like, no matter which side
  // wrote it. Equal means there is nothing to say.
  if (hash === state.lastPushedHash) return;

  const [object] = await fetchObjects(input.dav, input.link.remoteHref, [state.remoteHref]);
  if (object === undefined) {
    input.logger.warn('Calendar object to update is gone, leaving it to the next pull', {
      href: state.remoteHref,
    });
    input.result.conflicts += 1;
    return;
  }

  const patched = patchEventIcs(object.ics, input.payload, { now: input.now });
  if (patched === null) {
    // The body no longer holds an event with this UID: the object at that path was
    // replaced by a different appointment. Not ours to overwrite.
    input.logger.warn('Calendar object no longer holds the expected UID', {
      href: state.remoteHref,
      uid: state.icsUid,
    });
    input.result.conflicts += 1;
    return;
  }

  const written = await putCalendarObject(input.dav, {
    href: state.remoteHref,
    ics: patched,
    // The etag just read, not the stored one: it is the version the patch was
    // actually built on.
    ifMatch: object.etag ?? state.etag,
  });
  if (!written.written) {
    input.result.conflicts += 1;
    return;
  }

  await input.prisma.calendarObjectState.update({
    where: { id: state.id },
    data: {
      etag: written.etag,
      lastPushedHash: hash,
      occurrenceStart: new Date(input.payload.start),
      lastSeenAt: input.now,
    },
  });
  input.result.updated += 1;
}

/**
 * Removes objects whose row is gone.
 *
 * A row missing from the listing is not proof on its own: the query returns live
 * rows only, so a row could also be absent because of a paging mistake. Each
 * candidate is therefore looked up individually, and only an actually archived or
 * actually deleted row leads to a delete on the calendar.
 */
async function deleteVanished(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  liveRowIds: ReadonlySet<string>;
  states: CalendarObjectState[];
  now: Date;
  result: PushLinkResult;
}): Promise<void> {
  for (const state of input.states) {
    if (state.rowDocumentId === null || input.liveRowIds.has(state.rowDocumentId)) continue;
    // Only what this sync created. Everything else stays on the calendar even when
    // its row is archived, because the appointment does not belong to the mirror.
    if (state.origin !== 'LOCAL') continue;
    if (!(await isRowGone(input.client, state.rowDocumentId))) continue;

    const deleted = await deleteCalendarObject(input.dav, {
      href: state.remoteHref,
      ifMatch: state.etag,
    });
    if (!deleted) {
      input.result.conflicts += 1;
      continue;
    }

    await input.prisma.calendarObjectState.update({
      where: { id: state.id },
      data: { deletedAt: input.now, rowDocumentId: null },
    });
    input.result.deleted += 1;
  }
}

async function isRowGone(client: ExocortexApiClient, rowDocumentId: string): Promise<boolean> {
  try {
    const document = await client.request({
      method: 'GET',
      path: `/api/documents/${rowDocumentId}`,
      responseSchema: documentSummarySchema,
    });
    return document.archivedAt !== null;
  } catch (error) {
    if (error instanceof ExocortexApiError && error.code === 'not_found') return true;
    throw error;
  }
}
