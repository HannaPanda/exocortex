import ICAL from 'ical.js';

import { hasExplicitEnd, registerTimezones, toIsoInstant } from './ical-values';
import { type CalendarOccurrence } from './types';

/**
 * Upper bound on iteration steps.
 *
 * A rule is allowed to be infinite, so something has to stop the walk. Reaching
 * the current year from a daily series that started in 2010 costs about 5.800
 * steps, each one a bit of date arithmetic, so this bound is generous for every
 * real calendar while still ending a pathological `FREQ=SECONDLY` in
 * milliseconds.
 */
const MAX_STEPS = 20_000;

export interface ResolveOccurrenceOptions {
  /** The moment "now" is measured against. Usually `new Date()`. */
  from: Date;
  /** When set, only a master with this UID is considered. */
  uid?: string | null;
}

/**
 * The occurrence of a series that is current or next, as of `options.from`.
 *
 * This is what makes a recurring appointment usable in a table: the stored
 * object says "yearly, starting 2022", and what a human needs to see is the date
 * it will next happen, not the date it first happened.
 *
 * An occurrence counts as current while it is still running, so today's all-day
 * birthday and a meeting that started ten minutes ago both win over tomorrow's.
 * When the rule is exhausted, the *last* occurrence is returned with
 * `isFinal: true` rather than null: a series that ended last year still belongs
 * in the calendar at the date it ended, and an empty cell would look like a bug.
 *
 * Overrides are applied, not skipped. A single moved instance (RECURRENCE-ID)
 * carries its own time, and reporting the rule's untouched slot instead would
 * name a time at which nothing happens.
 */
export function resolveOccurrence(
  ics: string,
  options: ResolveOccurrenceOptions,
): CalendarOccurrence | null {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);

  const components = root.getAllSubcomponents('vevent');
  const master = components.find(
    (component) =>
      !component.hasProperty('recurrence-id') &&
      (options.uid == null || component.getFirstPropertyValue('uid') === options.uid),
  );
  if (master === undefined) return null;

  const event = new ICAL.Event(master);
  if (!event.isRecurring()) {
    return {
      ...occurrenceOf(event, event.startDate, false),
      recurrenceId: null,
      isFinal: true,
    };
  }

  const iterator = event.iterator();
  const reference = options.from.getTime();
  let last: CalendarOccurrence | null = null;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const slot = iterator.next();
    if (slot === null || slot === undefined) break;

    const details = event.getOccurrenceDetails(slot);
    const current: CalendarOccurrence = {
      ...occurrenceOf(details.item, details.startDate, details.item !== event, details.endDate),
      recurrenceId: toIsoInstant(details.recurrenceId),
      isFinal: false,
    };

    if (!hasPassed(current, reference)) {
      // Peeking one step further is the only way to know whether this is the
      // last one, and knowing that is what lets a caller stop asking again.
      const following = iterator.next();
      return { ...current, isFinal: following === null || following === undefined };
    }
    last = current;
  }

  if (last === null) return null;
  return { ...last, isFinal: iterator.complete === true };
}

/** Whether an occurrence is already over at `reference` (epoch milliseconds). */
function hasPassed(occurrence: CalendarOccurrence, reference: number): boolean {
  if (occurrence.end !== null) return Date.parse(occurrence.end) <= reference;
  // A point in time is over the moment it happens.
  return Date.parse(occurrence.start) < reference;
}

/**
 * One occurrence's instants.
 *
 * `endDate` is taken from ical.js when a caller has it, because for an override
 * it is the override's own end. The `null` case is this package's own
 * convention: ical.js reports a timed event without DTEND and without DURATION
 * as ending the moment it starts, while downstream a null end is what "a point
 * in time" means.
 */
function occurrenceOf(
  event: ICAL.Event,
  startDate: ICAL.Time,
  overridden: boolean,
  endDate?: ICAL.Time,
): Omit<CalendarOccurrence, 'recurrenceId' | 'isFinal'> {
  const allDay = startDate.isDate;
  const end = allDay || hasExplicitEnd(event.component) ? (endDate ?? event.endDate) : null;
  return {
    start: toIsoInstant(startDate),
    end: end === null ? null : toIsoInstant(end),
    allDay,
    overridden,
  };
}

/** German weekday abbreviations, in the order iCalendar names them. */
const WEEKDAYS: Record<string, string> = {
  MO: 'Mo',
  TU: 'Di',
  WE: 'Mi',
  TH: 'Do',
  FR: 'Fr',
  SA: 'Sa',
  SU: 'So',
};

const FREQUENCIES: Record<string, { every: string; plural: string }> = {
  DAILY: { every: 'täglich', plural: 'Tage' },
  WEEKLY: { every: 'wöchentlich', plural: 'Wochen' },
  MONTHLY: { every: 'monatlich', plural: 'Monate' },
  YEARLY: { every: 'jährlich', plural: 'Jahre' },
  HOURLY: { every: 'stündlich', plural: 'Stunden' },
  MINUTELY: { every: 'minütlich', plural: 'Minuten' },
};

/**
 * A recurrence rule as a German phrase, e.g. "alle 2 Wochen (Di, Do), bis
 * 31.12.2026".
 *
 * The rule itself stays in the mirrored object; this is only what a human reads
 * in the table, and "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH" is not that. Anything
 * the vocabulary below does not cover falls back to the raw rule, which is
 * unpretty but never wrong.
 */
export function describeRecurrence(rrule: string): string {
  const parts = new Map<string, string>();
  for (const chunk of rrule.split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    parts.set(chunk.slice(0, index).trim().toUpperCase(), chunk.slice(index + 1).trim());
  }

  const frequency = FREQUENCIES[(parts.get('FREQ') ?? '').toUpperCase()];
  if (frequency === undefined) return rrule;

  const interval = Number(parts.get('INTERVAL') ?? '1');
  const base =
    Number.isFinite(interval) && interval > 1
      ? `alle ${interval} ${frequency.plural}`
      : frequency.every;

  const days = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((token) => describeWeekday(token))
    .filter((token): token is string => token !== null);

  const suffixes: string[] = [];
  const until = parts.get('UNTIL');
  if (until !== undefined) {
    const date = describeUntil(until);
    if (date !== null) suffixes.push(`bis ${date}`);
  }
  const count = Number(parts.get('COUNT') ?? '');
  if (Number.isFinite(count) && count > 0) suffixes.push(`${count} Mal`);

  const head = days.length === 0 ? base : `${base} (${days.join(', ')})`;
  return suffixes.length === 0 ? head : `${head}, ${suffixes.join(', ')}`;
}

/** `MO` becomes "Mo", `2MO` becomes "2. Mo", `-1FR` becomes "letzter Fr". */
function describeWeekday(token: string): string | null {
  const match = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(token.trim());
  if (match === null) return null;
  const day = WEEKDAYS[match[2]!.toUpperCase()]!;
  const ordinal = match[1];
  if (ordinal === undefined) return day;
  if (ordinal.startsWith('-')) return `letzter ${day}`;
  return `${Number(ordinal)}. ${day}`;
}

/** An UNTIL value (`20261231` or `20261231T235959Z`) as a German date. */
function describeUntil(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (match === null) return null;
  return `${match[3]}.${match[2]}.${match[1]}`;
}
