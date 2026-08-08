import { createHash, randomUUID } from 'node:crypto';

/**
 * The fields Exocortex owns on an appointment, and nothing else.
 *
 * This is the whole contract between the two directions of the sync: a pull
 * writes these fields into a row, a push reads them back out of it, and the hash
 * below is what tells "somebody edited the row" from "the row is echoing what we
 * ourselves wrote a minute ago". Anything a calendar object carries beyond these
 * fields (attendees, alarms, categories) is deliberately absent, because the
 * mirror does not own it and a write-back must leave it untouched.
 */
export interface CalendarEventPayload {
  /** The iCalendar UID. Not part of the hash: it identifies, it never changes. */
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  /** ISO instant. For an all-day event the floating date at UTC midnight. */
  start: string;
  /** Exclusive end, or null for a point in time. */
  end: string | null;
  allDay: boolean;
}

/**
 * A stable fingerprint of the owned fields.
 *
 * Loop prevention, and the reason it has to be a hash of the *content* rather
 * than a timestamp: our own push makes the remote object change, the next pull
 * therefore rewrites the row, and a modification time would present that echo as
 * a fresh local edit -- one write per pass, forever. The content of the echo is
 * by definition what we sent, so its hash matches and the loop never starts.
 */
export function hashCalendarEventPayload(payload: CalendarEventPayload): string {
  const canonical = JSON.stringify([
    normalizeText(payload.summary),
    normalizeText(payload.description),
    normalizeText(payload.location),
    normalizeInstant(payload.start),
    normalizeInstant(payload.end),
    payload.allDay,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * An empty cell and an absent one are the same appointment.
 *
 * Without this, clearing a location by deleting its text would hash differently
 * from a location that was never set, and the sync would push a change that
 * changes nothing.
 */
function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Instants are compared as instants, not as strings: `2026-08-17T00:00:00Z` and
 * `2026-08-17T00:00:00.000Z` are the same moment, and different writers spell it
 * differently.
 */
function normalizeInstant(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/**
 * A UID for an appointment created in Exocortex.
 *
 * A random UUID rather than the row's document id: the UID follows the event to
 * every server and client that ever sees it, and it is the key another provider
 * will de-duplicate the same invitation by, so it must not leak an internal id.
 */
export function newCalendarUid(): string {
  return `${randomUUID()}@exocortex`;
}
