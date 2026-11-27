/**
 * A time of day as a person reads and types it (issue #255).
 *
 * Two things the browser's own time field could not do: write the time on the
 * clock of the interface language (the field follows the operating system, so
 * a German interface showed "12:00 PM" on an English Windows), and follow a
 * person who chose a 24- or 12-hour clock against their language. Everything
 * here is pure, so `apps/web` tests it without a browser.
 *
 * The value is the string a `type="time"` input held, `HH:MM` on a 24-hour
 * clock, so every call site keeps its conversions. It is a wall-clock time and
 * carries no zone: which day and zone it belongs to is the caller's business.
 */

/**
 * The clock a time is written on, as `Intl` names it: `h23` is 0 to 23,
 * `h12` is 1 to 12 with a day period. `undefined` means "as the locale
 * writes it", which is what an account that never chose gets.
 */
export type HourCycle = 'h23' | 'h12';

/** The account preference (`auto`, `24h`, `12h`) as the cycle `Intl` takes. */
export function hourCycleOf(timeFormat: string | null | undefined): HourCycle | undefined {
  if (timeFormat === '24h') return 'h23';
  if (timeFormat === '12h') return 'h12';
  return undefined;
}

/**
 * Adds the person's clock to a set of `Intl.DateTimeFormat` options, but only
 * when they show a time of day: a date alone has no clock, and a caller that
 * already named one (`hour12`, `hourCycle`) meant it.
 */
export function withHourCycle<T extends Intl.DateTimeFormatOptions>(
  options: T,
  cycle: HourCycle | undefined,
): T {
  if (cycle === undefined) return options;
  if (options.timeStyle === undefined && options.hour === undefined) return options;
  if (options.hourCycle !== undefined || options.hour12 !== undefined) return options;
  return { ...options, hourCycle: cycle };
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` as hours and minutes, or null for anything else. */
export function readTimeOfDay(value: string | null | undefined): [number, number] | null {
  const match = TIME_OF_DAY.exec(value ?? '');
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

function pad(part: number): string {
  return String(part).padStart(2, '0');
}

/** Hours and minutes as `HH:MM`. */
export function timeOfDay(hours: number, minutes: number): string {
  return `${pad(hours)}:${pad(minutes)}`;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function shortTimeFormatter(locale: string, cycle: HourCycle | undefined): Intl.DateTimeFormat {
  const key = `${locale}|${cycle ?? 'auto'}`;
  let formatter = formatterCache.get(key);
  if (formatter === undefined) {
    // UTC on both sides, so no zone and no daylight saving change can move
    // a wall-clock time that has none.
    formatter = new Intl.DateTimeFormat(
      locale,
      withHourCycle({ timeStyle: 'short', timeZone: 'UTC' }, cycle),
    );
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** `HH:MM` the way `locale` on `cycle` writes it: `14:30`, `2:30 PM`. Empty for no time. */
export function formatTimeOfDay(
  value: string | null | undefined,
  locale: string,
  cycle: HourCycle | undefined,
): string {
  const parts = readTimeOfDay(value);
  if (parts === null) return '';
  return shortTimeFormatter(locale, cycle).format(Date.UTC(2000, 0, 1, parts[0], parts[1]));
}

/**
 * The words for before and after noon a person may type: the locale's own
 * day periods (read from `Intl`, so every language brings its own) and the
 * English ones, which are typed everywhere.
 */
function dayPeriods(locale: string): { am: string[]; pm: string[] } {
  const am = new Set(['am', 'a.m.', 'a']);
  const pm = new Set(['pm', 'p.m.', 'p']);
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      hourCycle: 'h12',
      timeZone: 'UTC',
    });
    const periodAt = (hour: number) =>
      formatter
        .formatToParts(Date.UTC(2000, 0, 1, hour))
        .find((part) => part.type === 'dayPeriod')
        ?.value.toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    const morning = periodAt(1);
    const evening = periodAt(13);
    if (morning !== undefined && morning.length > 0) am.add(morning);
    if (evening !== undefined && evening.length > 0) pm.add(evening);
  } catch {
    // An unknown locale keeps the English words.
  }
  // Longest first, so "p.m." is taken before "p".
  const byLength = (left: string, right: string) => right.length - left.length;
  return { am: [...am].sort(byLength), pm: [...pm].sort(byLength) };
}

function stripPeriod(text: string, words: readonly string[]): string | null {
  for (const word of words) {
    if (text.endsWith(word)) return text.slice(0, -word.length).trim();
    if (text.startsWith(word)) return text.slice(word.length).trim();
  }
  return null;
}

/**
 * What a person typed as `HH:MM`, or null when it is not a time.
 *
 * Takes the clock they typed, whatever the field shows: `14:30`, `14.30`,
 * `14h30`, `1430`, `930`, `9`, `2:30 pm`, `2 PM`, and the locale's own day
 * period. With a period the hour is 1 to 12 (12 AM is midnight, 12 PM noon);
 * without one it is 0 to 23. Nothing is guessed: `25:00`, `9:7` and `13 pm`
 * are not times.
 */
export function parseTimeOfDay(text: string, locale: string): string | null {
  let rest = text.toLowerCase().replace(/[  ]/g, ' ').trim();
  if (rest.length === 0) return null;

  const periods = dayPeriods(locale);
  let period: 'am' | 'pm' | null = null;
  const withoutPm = stripPeriod(rest, periods.pm);
  if (withoutPm !== null) {
    period = 'pm';
    rest = withoutPm;
  } else {
    const withoutAm = stripPeriod(rest, periods.am);
    if (withoutAm !== null) {
      period = 'am';
      rest = withoutAm;
    }
  }
  rest = rest.replace(/\s+/g, '');

  let hours: number;
  let minutes: number;
  const separated = /^(\d{1,2})(?:[:.h](\d{2})?)?$/.exec(rest);
  const packed = /^(\d{1,2})(\d{2})$/.exec(rest);
  if (separated !== null) {
    hours = Number(separated[1]);
    minutes = separated[2] === undefined ? 0 : Number(separated[2]);
  } else if (packed !== null) {
    hours = Number(packed[1]);
    minutes = Number(packed[2]);
  } else {
    return null;
  }
  if (minutes > 59) return null;

  if (period === null) return hours <= 23 ? timeOfDay(hours, minutes) : null;
  if (hours < 1 || hours > 12) return null;
  const base = hours % 12;
  return timeOfDay(period === 'pm' ? base + 12 : base, minutes);
}

/**
 * The time `delta` minutes away, round the clock: the arrow keys move a
 * quarter of an hour and land on the quarter, so 09:07 goes to 09:15 and
 * 09:00, never to 09:22.
 */
export function stepTimeOfDay(value: string | null | undefined, delta: number): string {
  const parts = readTimeOfDay(value) ?? [9, 0];
  const total = parts[0] * 60 + parts[1];
  const size = Math.abs(delta);
  const snapped =
    delta > 0 ? Math.floor(total / size) * size + size : Math.ceil(total / size) * size - size;
  const wrapped = ((snapped % 1440) + 1440) % 1440;
  return timeOfDay(Math.floor(wrapped / 60), wrapped % 60);
}
