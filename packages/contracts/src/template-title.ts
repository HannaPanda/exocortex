/**
 * The title a page copied from a template gets (issue #79, ADR-039).
 *
 * A pure function in the contracts package because both halves of the feature
 * need the same answer and must not disagree about it: the API builds the real
 * title with it, and the browser shows a preview while the pattern is still
 * being typed. A second implementation in the client would drift the day
 * somebody adds a placeholder.
 *
 * Placeholders are German because the pattern is written by a human in the UI,
 * and an unknown one is left standing rather than replaced by an empty string:
 * a typo that shows up in the title as `{{datm}}` is a typo the author can see
 * and fix, whereas a silently swallowed one produces `Notiz ` and no reason.
 */

/** What may appear between `{{` and `}}`, and what each one stands for. */
export const TEMPLATE_TITLE_PLACEHOLDERS: Readonly<Record<string, string>> = {
  titel: 'Der Titel der Vorlage, oder was beim Anlegen eingegeben wurde',
  datum: 'Das Datum, 2026-09-18',
  zeit: 'Die Uhrzeit, 14:05',
  jahr: 'Das Jahr, 2026',
  monat: 'Der Monat, 09',
  monatsname: 'Der Monat ausgeschrieben, September',
  tag: 'Der Tag, 18',
  wochentag: 'Der Wochentag, Donnerstag',
  kw: 'Die Kalenderwoche nach ISO 8601, 38',
};

/** Longest title a pattern may produce, matching `documentTitleSchema`. */
const TITLE_MAX_LENGTH = 300;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Zäöüß]+)\s*\}\}/g;

/**
 * The parts of `now` as they read in `timeZone`.
 *
 * `Intl` rather than a date library: the deployment already depends on the
 * ICU data for the calendar, and the only thing needed here is the wall clock
 * in one zone. An unknown zone throws inside `Intl`, so it is caught and the
 * server's own clock is used -- a title is not worth failing a page creation
 * over a misconfigured setting.
 */
function partsIn(now: Date, timeZone: string): Record<string, string> {
  const format = (options: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat('de-DE', { timeZone, ...options }).format(now);
    } catch {
      return new Intl.DateTimeFormat('de-DE', options).format(now);
    }
  };

  const year = format({ year: 'numeric' });
  const month = format({ month: '2-digit' });
  const day = format({ day: '2-digit' });

  return {
    datum: `${year}-${month}-${day}`,
    zeit: format({ hour: '2-digit', minute: '2-digit', hour12: false }),
    jahr: year,
    monat: month,
    monatsname: format({ month: 'long' }),
    tag: day,
    wochentag: format({ weekday: 'long' }),
    kw: String(isoWeek(Number(year), Number(month), Number(day))),
  };
}

/**
 * ISO 8601 week number of a local calendar date.
 *
 * Computed from the parts rather than from the instant: the week is a property
 * of the date somebody is looking at in their zone, and deriving it from UTC
 * would put a Monday morning in Berlin into the previous week.
 */
function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Thursday decides which year a week belongs to (ISO 8601).
  const dayOfWeek = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

export interface TitlePatternInput {
  /** The pattern, or null to use `fallbackTitle` unchanged. */
  pattern: string | null;
  /** What `{{titel}}` stands for, and the answer when there is no pattern. */
  fallbackTitle: string;
  now: Date;
  /** IANA zone the date placeholders are read in, e.g. `Europe/Berlin`. */
  timeZone: string;
}

export function renderTitlePattern(input: TitlePatternInput): string {
  const source = input.pattern === null ? null : input.pattern.trim();
  if (source === null || source.length === 0) return input.fallbackTitle;

  const values: Record<string, string> = {
    ...partsIn(input.now, input.timeZone),
    titel: input.fallbackTitle,
  };
  const rendered = source.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    const value = values[name.toLowerCase()];
    return value ?? whole;
  });

  const trimmed = rendered.trim();
  if (trimmed.length === 0) return input.fallbackTitle;
  return trimmed.length > TITLE_MAX_LENGTH ? trimmed.slice(0, TITLE_MAX_LENGTH) : trimmed;
}
