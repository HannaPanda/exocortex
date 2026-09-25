import { type DatabaseRow, type DatabaseRowPropertyValue } from '@exocortex/contracts';

/**
 * One row as the calendar sees it: the span it occupies, independent of which
 * mode is drawing it. Every mode starts from this list.
 */
export interface CalendarEntry {
  row: DatabaseRow;
  start: string;
  /** `null` for a row with no stated end. Modes with a time axis give it a default length. */
  end: string | null;
  allDay: boolean;
}

export function pad(part: number): string {
  return String(part).padStart(2, '0');
}

/** The local calendar day of a `Date`, as `YYYY-MM-DD`. Never `toISOString`, which is UTC. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Which grid cell an instant belongs in.
 *
 * The two cases are not interchangeable. An all-day value is a *floating*
 * calendar date stored as UTC midnight, so it is read straight off the ISO
 * string: converting it into the viewer's zone would push every birthday a day
 * back for anyone west of Greenwich. A timed value is a real instant, so it
 * belongs in the day the viewer sees it in, which for a 00:30 Berlin
 * appointment is *not* its UTC day.
 */
export function dayKeyOf(iso: string, allDay: boolean): string {
  if (allDay) return iso.slice(0, 10);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return dayKey(date);
}

/**
 * Upper bound on how many cells one row may occupy. A span longer than a year
 * is a data error rather than an appointment, and without the cap a single bad
 * row would allocate an entry per day for as long as it lasts.
 */
const MAX_SPANNED_DAYS = 366;

/** Reads either DATE response shape; null for anything the calendar cannot plot. */
export function readCalendarDate(
  value: DatabaseRowPropertyValue['value'] | undefined,
): { start: string; end: string | null; allDay: boolean } | null {
  if (typeof value === 'string') return { start: value, end: null, allDay: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    return { start: value.start, end: value.end, allDay: value.allDay };
  }
  return null;
}

/**
 * Every day key a value covers. `end` is exclusive, so a span ending at
 * midnight does not bleed into the next cell: the last covered day is the one
 * containing `end - 1ms`.
 */
export function coveredDayKeys(start: string, end: string | null, allDay: boolean): string[] {
  const startKey = dayKeyOf(start, allDay);
  if (end === null) return [startKey];

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return [startKey];
  if (endDate.getTime() <= startDate.getTime()) return [startKey];

  const lastKey = dayKeyOf(new Date(endDate.getTime() - 1).toISOString(), allDay);
  const keys: string[] = [];
  const cursor = new Date(startDate);
  while (keys.length < MAX_SPANNED_DAYS) {
    const key = dayKeyOf(cursor.toISOString(), allDay);
    // Stepping 24h can land on the same local date across a DST change, so a
    // repeat is skipped rather than producing the row twice in one cell.
    if (keys[keys.length - 1] !== key) keys.push(key);
    if (key === lastKey) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

/** Rows that carry a readable value on `propertyId`, in the order they arrived. */
export function toCalendarEntries(
  rows: readonly DatabaseRow[],
  propertyId: string,
): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const row of rows) {
    const span = readCalendarDate(row.values.find((e) => e.propertyId === propertyId)?.value);
    if (span === null) continue;
    entries.push({ row, start: span.start, end: span.end, allDay: span.allDay });
  }
  return entries;
}

const collators = new Map<string, Intl.Collator>();

/** Titles in the reader's alphabetical order, one collator per locale. */
export function compareTitles(locale: string, left: string, right: string): number {
  let collator = collators.get(locale);
  if (collator === undefined) {
    collator = new Intl.Collator(locale);
    collators.set(locale, collator);
  }
  return collator.compare(left, right);
}

/**
 * Chronological, all-day first: the order a single day is read in. The start
 * is an ISO timestamp and compares by code unit; only a tie falls back to the
 * title, which is read alphabetically in `locale`.
 */
export function compareEntries(locale: string, left: CalendarEntry, right: CalendarEntry): number {
  if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
  if (left.start !== right.start) return left.start < right.start ? -1 : 1;
  return compareTitles(locale, left.row.document.title, right.row.document.title);
}

/**
 * Entries keyed by every day they touch. A span occupies every day it covers,
 * not only the day it starts on: a three-day trip that appears in one cell
 * reads as a one-day trip.
 */
export function groupEntriesByDay(
  entries: readonly CalendarEntry[],
  locale: string,
): Map<string, CalendarEntry[]> {
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    for (const key of coveredDayKeys(entry.start, entry.end, entry.allDay)) {
      const list = byDay.get(key);
      if (list === undefined) byDay.set(key, [entry]);
      else list.push(entry);
    }
  }
  for (const list of byDay.values())
    list.sort((left, right) => compareEntries(locale, left, right));
  return byDay;
}
