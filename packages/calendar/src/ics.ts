import ICAL from 'ical.js';

import {
  type ParsedCalendarEvent,
  type ParsedCalendarObject,
  type ParsedCalendarTodo,
} from './types';

export interface ParseOptions {
  /**
   * The account's own addresses, with or without a `mailto:` prefix. Used to
   * pick the right ATTENDEE when reading the participation status: an
   * invitation lists everyone, and the other guests' answers are not ours.
   */
  selfAddresses?: readonly string[];
}

/** One millisecond short of a day, for the all-day default duration. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parses one calendar object into typed events and todos.
 *
 * A single `.ics` resource is not a single appointment: it holds a recurring
 * series together with its per-instance overrides, so both lists may hold more
 * than one entry and a caller has to keep them together under one UID.
 *
 * Hand-rolling this was never an option. Real calendar data folds long lines at
 * 75 octets and escapes commas inside text, so the very first event this was
 * tested against ("Jahrestag erstes Treffen\, 2022") would already have come
 * out wrong from a regex.
 */
export function parseCalendarObject(ics: string, options: ParseOptions = {}): ParsedCalendarObject {
  const root = new ICAL.Component(ICAL.parse(ics));

  // Timezone definitions travel inside the object that uses them. Without
  // registering them first, a `TZID=Europe/Berlin` start time is read in the
  // wrong zone, which moves every appointment by one or two hours.
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone(vtimezone);
    if (!ICAL.TimezoneService.has(timezone.tzid)) {
      ICAL.TimezoneService.register(timezone);
    }
  }

  const self = new Set(
    (options.selfAddresses ?? []).map((address) => normalizeAddress(address)),
  );

  return {
    events: root.getAllSubcomponents('vevent').map((component) => readEvent(component, self)),
    todos: root.getAllSubcomponents('vtodo').map((component) => readTodo(component)),
  };
}

function readEvent(component: ICAL.Component, self: ReadonlySet<string>): ParsedCalendarEvent {
  const startProperty = component.getFirstProperty('dtstart');
  const start = startProperty?.getFirstValue();
  if (!(start instanceof ICAL.Time)) {
    throw new Error('VEVENT without a usable DTSTART');
  }
  const allDay = start.isDate;

  return {
    uid: text(component, 'uid') ?? '',
    summary: text(component, 'summary') ?? '',
    description: text(component, 'description'),
    location: text(component, 'location'),
    start: toIsoInstant(start),
    end: readEnd(component, start, allDay),
    allDay,
    // The parameter, not the resolved zone: this records where the event was
    // authored, which is what a write-back has to reproduce.
    timeZone: allDay ? null : (startProperty?.getParameter('tzid') as string | undefined) ?? null,
    rrule: readRrule(component),
    recurrenceId: readRecurrenceId(component),
    organizer: normalizeOptionalAddress(text(component, 'organizer')),
    partStat: readPartStat(component, self),
    status: text(component, 'status'),
    // Absent SEQUENCE means 0 (RFC 5545). Used to tell which side of a
    // two-way sync holds the newer version of an invitation.
    sequence: numeric(component, 'sequence') ?? 0,
    lastModified: readTimeProperty(component, 'last-modified'),
  };
}

/**
 * The exclusive end of the event.
 *
 * Three cases, and the defaults are the specified ones rather than convenient
 * guesses. An explicit DTEND wins. A DURATION is added to the start. With
 * neither, an all-day event lasts one day (so a one-day event ends on the
 * following date, exactly as mailbox.org writes it out), while a timed event has
 * zero duration -- which is reported as `null`, because "a point in time" is
 * precisely what a null end means downstream.
 */
function readEnd(component: ICAL.Component, start: ICAL.Time, allDay: boolean): string | null {
  const end = component.getFirstPropertyValue('dtend');
  if (end instanceof ICAL.Time) return toIsoInstant(end);

  const duration = component.getFirstPropertyValue('duration');
  if (duration instanceof ICAL.Duration) {
    const shifted = start.clone();
    shifted.addDuration(duration);
    return toIsoInstant(shifted);
  }

  if (allDay) {
    return new Date(Date.parse(toIsoInstant(start)) + MS_PER_DAY).toISOString();
  }
  return null;
}

/**
 * An ICAL.Time as an ISO instant.
 *
 * The two branches are the whole timezone story of this package. A DATE value
 * is a floating calendar date and is pinned to UTC midnight, so it survives
 * every zone unchanged -- a birthday must not move. A DATE-TIME value is a real
 * instant and is converted through its own zone.
 */
function toIsoInstant(time: ICAL.Time): string {
  if (time.isDate) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day)).toISOString();
  }
  return time.toJSDate().toISOString();
}

function readRrule(component: ICAL.Component): string | null {
  const rrule = component.getFirstPropertyValue('rrule');
  if (rrule === null || rrule === undefined) return null;
  // Stored as text and expanded on read. Materializing a yearly series into
  // rows would mean one row per year, for every year the rule covers.
  return String(rrule);
}

function readRecurrenceId(component: ICAL.Component): string | null {
  const value = component.getFirstPropertyValue('recurrence-id');
  return value instanceof ICAL.Time ? toIsoInstant(value) : null;
}

function readTimeProperty(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? toIsoInstant(value) : null;
}

/** The account's own PARTSTAT, or null when no attendee matches it. */
function readPartStat(component: ICAL.Component, self: ReadonlySet<string>): string | null {
  if (self.size === 0) return null;
  for (const attendee of component.getAllProperties('attendee')) {
    const address = normalizeOptionalAddress(String(attendee.getFirstValue() ?? ''));
    if (address === null || !self.has(normalizeAddress(address))) continue;
    const status = attendee.getParameter('partstat');
    if (typeof status === 'string') return status;
  }
  return null;
}

function readTodo(component: ICAL.Component): ParsedCalendarTodo {
  const due = component.getFirstPropertyValue('due');
  const dueTime = due instanceof ICAL.Time ? due : null;
  return {
    uid: text(component, 'uid') ?? '',
    summary: text(component, 'summary') ?? '',
    description: text(component, 'description'),
    due: dueTime === null ? null : toIsoInstant(dueTime),
    dueAllDay: dueTime?.isDate ?? false,
    status: text(component, 'status'),
    completedAt: readTimeProperty(component, 'completed'),
    percentComplete: numeric(component, 'percent-complete'),
    priority: numeric(component, 'priority'),
    lastModified: readTimeProperty(component, 'last-modified'),
  };
}

function text(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return null;
  const asText = typeof value === 'string' ? value : String(value);
  return asText.length === 0 ? null : asText;
}

function numeric(component: ICAL.Component, name: string): number | null {
  const value = component.getFirstPropertyValue(name);
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeAddress(address: string): string {
  return address.replace(/^mailto:/i, '').trim().toLowerCase();
}

function normalizeOptionalAddress(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.replace(/^mailto:/i, '').trim();
  return trimmed.length === 0 ? null : trimmed;
}
