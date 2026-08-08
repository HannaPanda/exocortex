import ICAL from 'ical.js';

import { readEnd, registerTimezones, toIsoInstant } from './ical-values';
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
  registerTimezones(root);

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
    // RDATE alone makes an event recurring too, and a caller that only looked at
    // RRULE would mirror such a series at its first date forever.
    recurs: component.hasProperty('rrule') || component.hasProperty('rdate'),
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
