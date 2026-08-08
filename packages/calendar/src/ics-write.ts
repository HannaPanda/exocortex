import ICAL from 'ical.js';

import { MS_PER_DAY } from './ical-values';
import { type CalendarEventPayload } from './payload';

/**
 * Writing iCalendar, the counterpart of `ics.ts`.
 *
 * Two entry points, and the difference between them is the whole point of this
 * module. A new appointment is built from nothing. An existing one is *patched*:
 * its body is parsed, only the fields Exocortex owns are replaced, and everything
 * else is written back untouched. Rebuilding a remote object from the mirrored
 * fields would silently delete its alarms, its attendees and its categories,
 * which is to say it would delete the reminder someone's phone depends on.
 */

/** Identifies the writer in every object we create. */
const PROD_ID = '-//Exocortex//Kalender//DE';

export interface WriteEventOptions {
  /** Passed in rather than read from the clock, so a test can assert DTSTAMP. */
  now: Date;
}

/** A complete calendar object for a new appointment. */
export function buildEventIcs(payload: CalendarEventPayload, options: WriteEventOptions): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.updatePropertyWithValue('prodid', PROD_ID);
  calendar.updatePropertyWithValue('version', '2.0');

  const event = new ICAL.Component('vevent');
  calendar.addSubcomponent(event);
  event.updatePropertyWithValue('uid', payload.uid);
  event.updatePropertyWithValue('created', utcTime(options.now));
  writeOwnedFields(event, payload, options.now);
  event.updatePropertyWithValue('sequence', 0);

  return terminate(calendar.toString());
}

/**
 * The given body with the owned fields replaced, or null when it holds no event
 * with that UID.
 *
 * Null rather than a thrown error: a body that does not contain the appointment
 * we meant to change is a state mismatch, and the caller's answer to that is to
 * re-read the object, not to abort the whole sync.
 */
export function patchEventIcs(
  existingIcs: string,
  payload: CalendarEventPayload,
  options: WriteEventOptions,
): string | null {
  const root = new ICAL.Component(ICAL.parse(existingIcs));
  const event = root
    .getAllSubcomponents('vevent')
    .find(
      (component) =>
        !component.hasProperty('recurrence-id') &&
        component.getFirstPropertyValue('uid') === payload.uid,
    );
  if (event === undefined) return null;

  writeOwnedFields(event, payload, options.now);
  // RFC 5545 asks for a bumped SEQUENCE on every substantive change. Free for an
  // object nobody was invited to, and required for one that has attendees:
  // without it a client is entitled to keep showing the version it already has.
  const sequence = event.getFirstPropertyValue('sequence');
  event.updatePropertyWithValue('sequence', (typeof sequence === 'number' ? sequence : 0) + 1);

  return terminate(root.toString());
}

/**
 * Writes the fields Exocortex owns, and only those.
 *
 * The times are removed and re-added rather than updated in place, which looks
 * like a detail and is not: `updatePropertyWithValue` keeps the property's
 * existing parameters, so an event that used to read
 * `DTSTART;TZID=Europe/Berlin` came out as `DTSTART;TZID=Europe/Berlin:…Z` --
 * a zone and a UTC marker on one value, which is not valid iCalendar and which
 * clients resolve in whichever way they please.
 */
function writeOwnedFields(
  event: ICAL.Component,
  payload: CalendarEventPayload,
  now: Date,
): void {
  setText(event, 'summary', payload.summary);
  setText(event, 'location', payload.location);
  setText(event, 'description', payload.description);

  event.removeAllProperties('dtstart');
  event.removeAllProperties('dtend');
  // DTEND and DURATION may never both be present, and the one we write is DTEND.
  event.removeAllProperties('duration');

  event.addPropertyWithValue('dtstart', instant(payload.start, payload.allDay));
  const end = endOf(payload);
  if (end !== null) event.addPropertyWithValue('dtend', instant(end, payload.allDay));

  event.updatePropertyWithValue('dtstamp', utcTime(now));
  event.updatePropertyWithValue('last-modified', utcTime(now));
}

/**
 * The end to write out, or null when the event is a point in time.
 *
 * An all-day event always gets an explicit, exclusive DTEND, defaulting to the
 * day after it starts: that is how a one-day event is spelled in iCalendar, and
 * how every calendar this syncs with writes it. A timed event without an end
 * gets no DTEND at all, which reads back as exactly the null it came from.
 */
function endOf(payload: CalendarEventPayload): string | null {
  if (payload.end !== null) return payload.end;
  if (!payload.allDay) return null;
  return new Date(Date.parse(payload.start) + MS_PER_DAY).toISOString();
}

/**
 * An ISO instant as an iCalendar value, in the same two flavours `toIsoInstant`
 * reads: a DATE for an all-day event, so a birthday stays on its date in every
 * zone, and a UTC DATE-TIME otherwise.
 *
 * UTC rather than the event's authored zone, and that is a deliberate narrowing:
 * the instant is preserved exactly, but a recurring event would need its original
 * zone to survive a DST boundary. Which is fine here, because a series is never
 * written back -- see `pushLink`.
 */
function instant(iso: string, allDay: boolean): ICAL.Time {
  const date = new Date(iso);
  if (!allDay) return utcTime(date);
  return ICAL.Time.fromData({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    isDate: true,
  });
}

function utcTime(date: Date): ICAL.Time {
  return ICAL.Time.fromJSDate(date, true);
}

/** An absent value removes the property rather than writing an empty one. */
function setText(event: ICAL.Component, name: string, value: string | null): void {
  const trimmed = value === null ? '' : value.trim();
  if (trimmed.length === 0) {
    event.removeAllProperties(name);
    return;
  }
  event.updatePropertyWithValue(name, trimmed);
}

/**
 * iCalendar lines end with CRLF, including the last one. ical.js leaves the
 * final one off, and a server is allowed to reject the body for it.
 */
function terminate(ics: string): string {
  return ics.endsWith('\r\n') ? ics : `${ics}\r\n`;
}
