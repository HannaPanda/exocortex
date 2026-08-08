import ICAL from 'ical.js';

/**
 * The value-level rules shared by every reader in this package.
 *
 * They live in one place because `ics.ts` (flattening an object into typed
 * values) and `recurrence.ts` (expanding a rule into occurrences) must agree on
 * them exactly. If they disagreed, a series' first occurrence would be stored
 * with one end and its next occurrence with another, and nobody would be able to
 * tell which of the two was right.
 */

/** One day in milliseconds, for the all-day default duration. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Registers every VTIMEZONE the object carries.
 *
 * Timezone definitions travel inside the object that uses them. Without
 * registering them first, a `TZID=Europe/Berlin` start time is read in the wrong
 * zone, which moves every appointment by one or two hours.
 */
export function registerTimezones(root: ICAL.Component): void {
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone(vtimezone);
    if (!ICAL.TimezoneService.has(timezone.tzid)) {
      ICAL.TimezoneService.register(timezone);
    }
  }
}

/**
 * An ICAL.Time as an ISO instant.
 *
 * The two branches are the whole timezone story of this package. A DATE value is
 * a floating calendar date and is pinned to UTC midnight, so it survives every
 * zone unchanged -- a birthday must not move. A DATE-TIME value is a real
 * instant and is converted through its own zone.
 */
export function toIsoInstant(time: ICAL.Time): string {
  if (time.isDate) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day)).toISOString();
  }
  return time.toJSDate().toISOString();
}

/**
 * The exclusive end of a VEVENT, or null when it is a point in time.
 *
 * Three cases, and the defaults are the specified ones rather than convenient
 * guesses. An explicit DTEND wins. A DURATION is added to the start. With
 * neither, an all-day event lasts one day (so a one-day event ends on the
 * following date, exactly as mailbox.org writes it out), while a timed event has
 * zero duration -- which is reported as `null`, because "a point in time" is
 * precisely what a null end means downstream.
 */
export function readEnd(
  component: ICAL.Component,
  start: ICAL.Time,
  allDay: boolean,
): string | null {
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
 * Whether the component states its own length.
 *
 * ical.js reports a timed event without DTEND and without DURATION as ending the
 * moment it starts. This package reports that as `null` instead, so the caller
 * has to be able to tell the two apart.
 */
export function hasExplicitEnd(component: ICAL.Component): boolean {
  return component.hasProperty('dtend') || component.hasProperty('duration');
}
