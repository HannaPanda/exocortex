import { type DatabaseCalendarMode } from '@exocortex/contracts';

/**
 * The window a mode shows, as local half-open `[from, to)`.
 *
 * Local rather than UTC throughout: a calendar answers "what does my Thursday
 * look like", and a viewer's Thursday is not the UTC day. Every boundary here
 * is built with the local `Date` constructor, whose day arithmetic already
 * accounts for a DST change inside the window.
 */
export interface CalendarWindow {
  from: Date;
  to: Date;
}

/**
 * Every date format the calendar draws, by role. The formatter is built once
 * per locale and role and then reused: constructing an `Intl.DateTimeFormat`
 * costs far more than formatting with one, and a month grid formats 42 cells.
 */
const DATE_FORMATS = {
  day: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  dayHeading: { weekday: 'long', day: 'numeric', month: 'long' },
  dayMonth: { day: 'numeric', month: 'long' },
  dayMonthYear: { day: 'numeric', month: 'long', year: 'numeric' },
  monthYear: { month: 'long', year: 'numeric' },
  month: { month: 'long' },
  numericDate: { day: 'numeric', month: 'numeric', year: 'numeric' },
  columnHeader: { weekday: 'short', day: 'numeric' },
  weekdayShort: { weekday: 'short' },
  weekdayNarrow: { weekday: 'narrow' },
  time: { hour: '2-digit', minute: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type CalendarDateFormat = keyof typeof DATE_FORMATS;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function calendarFormatter(locale: string, format: CalendarDateFormat): Intl.DateTimeFormat {
  const key = `${locale}|${format}`;
  let formatter = formatterCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, DATE_FORMATS[format]);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** Order of the mode switcher, coarse to fine is not it: a reader scans list, day, week, month, year. */
export const CALENDAR_MODES: DatabaseCalendarMode[] = ['LIST', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Monday of the week containing `date`. The week starts on Monday in every
 * locale for now, as it does in German calendars; a start per locale would
 * change the grids, the week window and the weekday header together.
 */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** The Monday on or before the first of the month: the first cell of the month grid. */
export function monthGridStart(year: number, month: number): Date {
  return startOfWeek(new Date(year, month, 1));
}

/**
 * Six weeks, always. A fixed height keeps the grid from jumping by a row
 * between months, and the leading/trailing days of the neighbouring months are
 * part of what a month view is for.
 */
export const MONTH_GRID_DAYS = 42;

export function calendarWindow(mode: DatabaseCalendarMode, anchor: Date): CalendarWindow {
  const day = startOfDay(anchor);
  switch (mode) {
    case 'DAY':
      return { from: day, to: addDays(day, 1) };
    case 'WEEK': {
      const from = startOfWeek(day);
      return { from, to: addDays(from, 7) };
    }
    case 'MONTH': {
      // The grid, not the month: the trailing cells of the neighbouring months
      // are drawn, so their entries have to be fetched too.
      const from = monthGridStart(day.getFullYear(), day.getMonth());
      return { from, to: addDays(from, MONTH_GRID_DAYS) };
    }
    case 'YEAR':
      return {
        from: new Date(day.getFullYear(), 0, 1),
        to: new Date(day.getFullYear() + 1, 0, 1),
      };
    case 'LIST':
      // The month proper. An agenda for September that silently began in late
      // August would be an agenda of a different month.
      return {
        from: new Date(day.getFullYear(), day.getMonth(), 1),
        to: new Date(day.getFullYear(), day.getMonth() + 1, 1),
      };
  }
}

/**
 * How far one press of the arrows moves, per mode. `LIST` steps by month
 * because it shows one, not because it is a month view.
 */
export function stepAnchor(mode: DatabaseCalendarMode, anchor: Date, direction: 1 | -1): Date {
  const day = startOfDay(anchor);
  switch (mode) {
    case 'DAY':
      return addDays(day, direction);
    case 'WEEK':
      return addDays(day, 7 * direction);
    case 'YEAR':
      return new Date(day.getFullYear() + direction, day.getMonth(), 1);
    case 'MONTH':
    case 'LIST':
      // Onto the first, never onto the 31st: stepping from 31 March by one
      // month would otherwise land in May.
      return new Date(day.getFullYear(), day.getMonth() + direction, 1);
  }
}

/**
 * How the two ends of a week are joined into one label. The sentence belongs
 * to the catalogue, so the caller words it; this module only decides which of
 * the three shapes a week needs and formats the dates in `locale`.
 */
export interface WeekLabelWording {
  /** Both ends in one month: the first day as a bare number, the last in full. */
  withinMonth: (fromDay: number, to: string) => string;
  range: (from: string, to: string) => string;
}

export function calendarLabel(
  mode: DatabaseCalendarMode,
  anchor: Date,
  locale: string,
  wording: WeekLabelWording,
): string {
  const day = startOfDay(anchor);
  switch (mode) {
    case 'DAY':
      return calendarFormatter(locale, 'day').format(day);
    case 'WEEK': {
      const from = startOfWeek(day);
      const to = addDays(from, 6);
      const full = calendarFormatter(locale, 'dayMonthYear');
      if (from.getFullYear() !== to.getFullYear()) {
        return wording.range(full.format(from), full.format(to));
      }
      if (from.getMonth() !== to.getMonth()) {
        return wording.range(calendarFormatter(locale, 'dayMonth').format(from), full.format(to));
      }
      return wording.withinMonth(from.getDate(), full.format(to));
    }
    case 'MONTH':
    case 'LIST':
      return calendarFormatter(locale, 'monthYear').format(day);
    case 'YEAR':
      return String(day.getFullYear());
  }
}

/** `YYYY-MM-DD` for the date input, which speaks no other format. */
export function toDateInputValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses the date input back. Returns null for the empty value the picker can produce. */
export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * One day of slack on each side of the window that is actually sent to the API.
 *
 * An all-day value is stored as UTC midnight (see `dayKeyOf`), so for a viewer
 * west of Greenwich a birthday on the first day of the window sorts *before*
 * the window's local start and would be missed. A day of padding costs one
 * extra day of rows; the client decides placement afterwards anyway.
 */
export function queryWindow(window: CalendarWindow): { from: string; to: string } {
  return {
    from: addDays(window.from, -1).toISOString(),
    to: addDays(window.to, 1).toISOString(),
  };
}

export function monthName(month: number, locale: string): string {
  return calendarFormatter(locale, 'month').format(new Date(2026, month, 1));
}

/**
 * The seven weekday names of a grid header, Monday first, in `locale`. Read off
 * a known Monday rather than a list, so every language names its own days.
 */
export function weekdayNames(locale: string, format: 'weekdayShort' | 'weekdayNarrow'): string[] {
  const monday = new Date(2026, 8, 14);
  const formatter = calendarFormatter(locale, format);
  return Array.from({ length: 7 }, (_, index) => formatter.format(addDays(monday, index)));
}
