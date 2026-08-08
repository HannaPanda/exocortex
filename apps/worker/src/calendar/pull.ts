import {
  type CalendarEventPayload,
  type CalendarObjectRef,
  type CalendarOccurrence,
  type DavClient,
  describeRecurrence,
  fetchObjects,
  hashCalendarEventPayload,
  listObjects,
  parseCalendarObject,
  type ParsedCalendarEvent,
  type ParsedCalendarTodo,
  resolveOccurrence,
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
  /**
   * Rows whose date was moved to a later occurrence without the remote object
   * having changed. This is time passing, not a sync event.
   */
  refreshed: number;
  /** Override components folded into their series; see the note below. */
  overrides: number;
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
  // One reading of "now" for the whole pass, so two rows of the same series
  // cannot end up on different sides of a midnight that fell mid-sync.
  const now = new Date();

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
    refreshed: 0,
    overrides: 0,
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
        // A repeating todo keeps its plain DUE date. A deadline that moves on its
        // own is a different feature from an appointment that recurs, and
        // pretending otherwise would silently reschedule someone's task.
        recurrenceIcs: null,
        occurrenceStart: null,
        // No todo is ever written outward yet, so there is no agreed-on version to
        // record. See `pushLink`.
        pushedHash: null,
        result,
      });
      continue;
    }

    // A recurring series and its per-instance overrides share one object. The
    // series (no RECURRENCE-ID) is the row; an override is a modification of one
    // occurrence, not a second appointment, and mirroring it as its own row would
    // show a duplicate. The overrides are not thrown away: `resolveOccurrence`
    // applies them, so a moved instance shows its new time.
    const master = parsed.events.find((event) => event.recurrenceId === null);
    result.overrides += parsed.events.filter((event) => event.recurrenceId !== null).length;
    if (master === undefined) continue;

    // A series is mirrored at the occurrence that is current or next, not at the
    // date it first happened. Otherwise a yearly appointment sits in the table
    // with the year it was created in, which is the one date it will never
    // happen again.
    const occurrence = master.recurs
      ? resolveOccurrence(object.ics, { from: now, uid: master.uid })
      : null;
    const payload = eventPayload(master, occurrence);

    await upsertRow({
      ...input,
      object,
      uid: master.uid,
      title: master.summary,
      organizer: master.organizer,
      partStat: master.partStat,
      remoteUpdatedAt: master.lastModified,
      values: eventValues(link.propertyMap, master, payload),
      // What the row now says, as the two directions agree to measure it. A push
      // compares the row against this, so the remote echo of our own write is
      // recognised as an echo instead of as a fresh local edit.
      pushedHash: hashCalendarEventPayload(payload),
      // The body is kept only for a series, because only a series needs to be
      // re-read as time passes -- and an unchanged etag means it will never be
      // fetched again.
      recurrenceIcs: master.recurs ? object.ics : null,
      occurrenceStart: occurrence?.start ?? null,
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

  result.refreshed = await refreshOccurrences({
    prisma,
    client: input.client,
    logger,
    link,
    now,
  });

  return result;
}

/**
 * Moves every mirrored series onto its current occurrence.
 *
 * This runs on every pass, independently of what the server reported, because a
 * series goes stale without anything changing remotely: last Monday's standup
 * becomes this Monday's by the clock alone, and its etag never moves. The rule is
 * read from the cached body, so this costs no network at all.
 *
 * The states are re-read rather than reused from the pass above on purpose: the
 * rows just written already carry the right occurrence, and a fresh read is what
 * makes them skip themselves here.
 */
async function refreshOccurrences(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  logger: Logger;
  link: { id: string; propertyMap: CalendarLinkPropertyMap };
  now: Date;
}): Promise<number> {
  const propertyId = input.link.propertyMap.date;
  if (propertyId === null) return 0;

  const states = await input.prisma.calendarObjectState.findMany({
    where: {
      linkId: input.link.id,
      deletedAt: null,
      recurrenceIcs: { not: null },
      rowDocumentId: { not: null },
    },
  });

  let refreshed = 0;
  for (const state of states) {
    if (state.recurrenceIcs === null || state.rowDocumentId === null) continue;

    let occurrence: CalendarOccurrence | null;
    try {
      occurrence = resolveOccurrence(state.recurrenceIcs, {
        from: input.now,
        uid: state.icsUid,
      });
    } catch (error) {
      // A body that cannot be expanded is not worth failing a whole sync over;
      // the row keeps the date it has.
      input.logger.warn('Could not expand a recurring calendar object', {
        stateId: state.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (occurrence === null) continue;

    const start = new Date(occurrence.start);
    if (state.occurrenceStart !== null && state.occurrenceStart.getTime() === start.getTime()) {
      continue;
    }

    const alive = await patchValues(
      input.client,
      state.rowDocumentId,
      [
        {
          propertyId,
          value: { start: occurrence.start, end: occurrence.end, allDay: occurrence.allDay },
        },
      ],
      input.logger,
    );
    if (!alive) {
      await input.prisma.calendarObjectState.update({
        where: { id: state.id },
        data: { rowDocumentId: null },
      });
      continue;
    }

    // `lastPushedHash` is left as it is, and that is deliberate: the row now says
    // something else than the hash records, but a series is never written back
    // (`pushLink` skips anything with a cached rule), so nothing reads the
    // difference. Recomputing it here would mean parsing the cached body again for
    // fields that did not change.
    await input.prisma.calendarObjectState.update({
      where: { id: state.id },
      data: { occurrenceStart: start },
    });
    refreshed += 1;
  }
  return refreshed;
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

/**
 * The fields of an event that the mirror owns, as one value.
 *
 * Both directions read it from here: the pull writes these fields into the row,
 * the push reads them back out of it, and the hash of this payload is what tells
 * a human's edit from the echo of our own write. Deriving it twice is how the two
 * directions would start disagreeing about what "unchanged" means.
 *
 * When an occurrence is given it wins over the event's own DTSTART: for a series
 * the master's start is the date the series began, which is exactly the date that
 * does not belong in a calendar.
 */
function eventPayload(
  event: ParsedCalendarEvent,
  occurrence: CalendarOccurrence | null,
): CalendarEventPayload {
  const span = occurrence ?? event;
  return {
    uid: event.uid,
    // The title as the row will actually carry it, empty summary included:
    // comparing the raw summary against a row that says "Ohne Titel" would report
    // a change on every single pass.
    summary: rowTitle(event.summary),
    description: event.description,
    location: event.location,
    start: span.start,
    end: span.end,
    allDay: span.allDay,
  };
}

/** The row values for one event. */
function eventValues(
  map: CalendarLinkPropertyMap,
  event: ParsedCalendarEvent,
  payload: CalendarEventPayload,
): DatabaseRowPropertyValue[] {
  const values: DatabaseRowPropertyValue[] = [];
  if (map.date !== null) {
    values.push({
      propertyId: map.date,
      value: { start: payload.start, end: payload.end, allDay: payload.allDay },
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
  if (map.recurrence !== null) {
    // German, because this column is read by a human. The rule itself stays in
    // the mirrored object, where a write-back can still reach it.
    values.push({
      propertyId: map.recurrence,
      value: event.rrule === null ? null : describeRecurrence(event.rrule),
    });
  }
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
  /** The raw body, for a recurring object only. Null clears a stale cache. */
  recurrenceIcs: string | null;
  /** Which occurrence the values name, so a later pass can tell it is stale. */
  occurrenceStart: string | null;
  /** Fingerprint of what was written, as the write-back direction measures it. */
  pushedHash: string | null;
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
    recurrenceIcs: input.recurrenceIcs,
    occurrenceStart: input.occurrenceStart === null ? null : new Date(input.occurrenceStart),
    lastPushedHash: input.pushedHash,
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
  } catch (error) {
    if (isGone(error)) {
      logger.debug('Calendar row is gone, will be recreated', { rowDocumentId });
      return false;
    }
    throw error;
  }
  return values.length === 0 ? true : patchValues(client, rowDocumentId, values, logger);
}

/** Writes cell values. Returns false when the row is gone. */
async function patchValues(
  client: ExocortexApiClient,
  rowDocumentId: string,
  values: DatabaseRowPropertyValue[],
  logger: Logger,
): Promise<boolean> {
  try {
    await client.request({
      method: 'PATCH',
      path: `/api/documents/${rowDocumentId}/values`,
      body: { values },
      responseSchema: databaseRowSchema,
    });
    return true;
  } catch (error) {
    if (isGone(error)) {
      logger.debug('Calendar row is gone, will be recreated', { rowDocumentId });
      return false;
    }
    throw error;
  }
}

function isGone(error: unknown): boolean {
  return (
    error instanceof ExocortexApiError &&
    (error.code === 'not_found' || error.code === 'document_archived')
  );
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
    if (isGone(error)) {
      return;
    }
    logger.warn('Could not archive a removed calendar row', { rowDocumentId });
  }
}
