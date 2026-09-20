import { z } from 'zod';

import {
  addLocalDays,
  daysInMonth,
  instantAtLocalTime,
  isUsableTimeZone,
  type LocalDate,
  localTimeParts,
  localWeekday,
} from './zoned-time';

/**
 * When a scheduled automation runs next (issue #73).
 *
 * One pure function, in the contracts package, because two sides have to agree
 * about it to the minute: the API computes `nextRunAt` when a rule is written,
 * and the worker's sweep computes the one after that when the rule has fired.
 * A second implementation would mean a rule that says one thing in the UI and
 * does another at four in the morning.
 *
 * There is deliberately no dependency here. A cron library would be a third
 * party deciding what "0 5 31 * *" means in a February, and the dialect below
 * is small enough to be read in one sitting and tested exhaustively.
 */

/** The shapes a person can express without learning cron. */
export const automationScheduleKindSchema = z.enum(['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'CRON']);
export type AutomationScheduleKind = z.infer<typeof automationScheduleKindSchema>;

/** `HH:MM`, 24 hours, local to the rule's zone. */
export const automationScheduleTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

/** Five fields, the classic order: minute hour day-of-month month day-of-week. */
export const automationCronSchema = z.string().trim().min(1).max(200);

/** An IANA zone name. Validated against the runtime, which is the only authority. */
export const automationTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isUsableTimeZone, { message: 'Unknown IANA time zone' });

/**
 * Everything the next-run calculation needs, in the shape the row stores.
 *
 * Columns rather than a JSON blob, for the reason the rest of `automation_rule`
 * gives: "every Sunday at 07:00 in Europe/Berlin" is a question a query has to
 * be able to answer, and a schedule nobody can query is a schedule nobody can
 * show a list of.
 */
export interface AutomationSchedule {
  kind: AutomationScheduleKind;
  /** `ONCE`: the absolute instant. Null for every other kind. */
  at: Date | null;
  /** `DAILY`/`WEEKLY`/`MONTHLY`: `HH:MM` in `timeZone`. */
  time: string | null;
  /** `WEEKLY`: 0 is Sunday, 6 is Saturday, the way `Date` counts. */
  weekday: number | null;
  /** `MONTHLY`: 1 to 31, clamped to the last day of a shorter month. */
  dayOfMonth: number | null;
  /** `CRON`: the expression. */
  cron: string | null;
  /** The zone every local time above is read in, and `ONCE` is displayed in. */
  timeZone: string;
}

/**
 * The schedule a stored rule carries, or `null` when it carries none.
 *
 * The one place the seven columns become one value. Both callers have a row
 * shaped like this: the API has just written it, the worker has just read it,
 * and neither should be re-deciding which fields matter for which kind.
 */
export function automationScheduleOf(fields: {
  scheduleKind: AutomationScheduleKind | null;
  scheduleAt: Date | string | null;
  scheduleTime: string | null;
  scheduleWeekday: number | null;
  scheduleDayOfMonth: number | null;
  scheduleCron: string | null;
  scheduleTimeZone: string | null;
}): AutomationSchedule | null {
  if (fields.scheduleKind === null || fields.scheduleTimeZone === null) return null;
  const at =
    fields.scheduleAt === null
      ? null
      : fields.scheduleAt instanceof Date
        ? fields.scheduleAt
        : new Date(fields.scheduleAt);
  return {
    kind: fields.scheduleKind,
    at: at === null || Number.isNaN(at.getTime()) ? null : at,
    time: fields.scheduleTime,
    weekday: fields.scheduleWeekday,
    dayOfMonth: fields.scheduleDayOfMonth,
    cron: fields.scheduleCron,
    timeZone: fields.scheduleTimeZone,
  };
}

/** How far ahead the search gives up. Four years covers a 29 February cron. */
const MAX_SEARCH_DAYS = 1_465;

/**
 * The first firing strictly after `after`, or `null` when there is none.
 *
 * `null` is a real answer, not a failure: a `ONCE` schedule whose moment has
 * passed has no next run, and the rule then sits there with an empty
 * `nextRunAt` instead of firing again for ever.
 */
export function nextAutomationRun(schedule: AutomationSchedule, after: Date): Date | null {
  if (schedule.kind === 'ONCE') {
    if (schedule.at === null) return null;
    return schedule.at.getTime() > after.getTime() ? schedule.at : null;
  }

  const minutes = candidateMinutes(schedule);
  if (minutes === null) return null;
  const matcher = dayMatcher(schedule);
  if (matcher === null) return null;

  const start = localTimeParts(after, schedule.timeZone);
  const startMinute = start.hour * 60 + start.minute;

  for (let offset = 0; offset < MAX_SEARCH_DAYS; offset += 1) {
    const day = addLocalDays(start, offset);
    if (!matcher(day)) continue;
    for (const minuteOfDay of minutes) {
      if (offset === 0 && minuteOfDay <= startMinute) continue;
      const instant = instantAtLocalTime(
        { ...day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
        schedule.timeZone,
      );
      // A local time that does not exist (the hour a zone skips in spring) is
      // pushed forward by the conversion rather than dropped, and one that
      // exists twice resolves to the first. Both may land at or before `after`,
      // which is what this guard is for.
      if (instant.getTime() > after.getTime()) return instant;
    }
  }
  return null;
}

/** Minutes of the day the schedule can fire at, ascending. */
function candidateMinutes(schedule: AutomationSchedule): number[] | null {
  if (schedule.kind === 'CRON') {
    const fields = parseCron(schedule.cron ?? '');
    if (fields === null) return null;
    const minutes: number[] = [];
    for (const hour of fields.hours) {
      for (const minute of fields.minutes) minutes.push(hour * 60 + minute);
    }
    return minutes.sort((left, right) => left - right);
  }
  if (schedule.time === null) return null;
  const [hourText, minuteText] = schedule.time.split(':');
  const hour = Number.parseInt(hourText ?? '', 10);
  const minute = Number.parseInt(minuteText ?? '', 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return [hour * 60 + minute];
}

/** Whether a given local date is one the schedule fires on. */
function dayMatcher(schedule: AutomationSchedule): ((date: LocalDate) => boolean) | null {
  switch (schedule.kind) {
    case 'DAILY':
      return () => true;
    case 'WEEKLY': {
      const weekday = schedule.weekday;
      if (weekday === null) return null;
      return (date) => localWeekday(date) === weekday;
    }
    case 'MONTHLY': {
      const wanted = schedule.dayOfMonth;
      if (wanted === null) return null;
      // A 31st in a 30-day month means the last day of that month, not "skip
      // this month": a monthly summary that silently misses February is a
      // monthly summary nobody can rely on.
      return (date) => date.day === Math.min(wanted, daysInMonth(date.year, date.month));
    }
    case 'CRON': {
      const fields = parseCron(schedule.cron ?? '');
      if (fields === null) return null;
      return (date) => cronMatchesDay(fields, date);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The cron dialect
// ---------------------------------------------------------------------------

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  weekdays: number[];
  /** Whether either day field is restricted, which is what makes them an OR. */
  dayOfMonthRestricted: boolean;
  weekdayRestricted: boolean;
}

/**
 * Five numeric fields with `*`, ranges, steps and lists, or `null`.
 *
 * Deliberately no `@daily`, no `JAN`, no `MON`, no `L` and no `#`: the three
 * shapes people actually ask for have their own kinds above, and an expression
 * this parser cannot read is refused when the rule is written rather than
 * misunderstood at half past four.
 */
export function parseCron(expression: string): CronFields | null {
  const [minuteField, hourField, dayField, monthField, weekdayField] = expression
    .trim()
    .split(/\s+/u);
  if (
    minuteField === undefined ||
    hourField === undefined ||
    dayField === undefined ||
    monthField === undefined ||
    weekdayField === undefined ||
    expression.trim().split(/\s+/u).length !== 5
  ) {
    return null;
  }

  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const daysOfMonth = parseField(dayField, 1, 31);
  const months = parseField(monthField, 1, 12);
  // 7 is Sunday as well, the way every cron implementation allows.
  const weekdays = parseField(weekdayField, 0, 7);
  if (
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    weekdays === null
  ) {
    return null;
  }

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    weekdays: [...new Set(weekdays.map((day) => day % 7))].sort((left, right) => left - right),
    dayOfMonthRestricted: dayField !== '*',
    weekdayRestricted: weekdayField !== '*',
  };
}

function parseField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    if (range === undefined) return null;
    const step = stepText === undefined ? 1 : Number.parseInt(stepText, 10);
    if (!Number.isInteger(step) || step < 1) return null;
    if (stepText !== undefined && !/^\d+$/u.test(stepText)) return null;

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (/^\d+$/u.test(range)) {
      from = Number.parseInt(range, 10);
      to = stepText === undefined ? from : max;
    } else {
      const bounds = /^(\d+)-(\d+)$/u.exec(range);
      if (bounds?.[1] === undefined || bounds[2] === undefined) return null;
      from = Number.parseInt(bounds[1], 10);
      to = Number.parseInt(bounds[2], 10);
    }
    if (from < min || to > max || from > to) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size === 0 ? null : [...values].sort((left, right) => left - right);
}

/**
 * The day half of a cron match.
 *
 * Day-of-month and day-of-week are an OR when both are restricted, which is
 * what every cron does and what surprises everybody once: `0 5 1 * 1` is the
 * first of the month *and* every Monday, not Mondays that fall on the first.
 */
function cronMatchesDay(fields: CronFields, date: LocalDate): boolean {
  if (!fields.months.includes(date.month)) return false;
  const byDay = fields.daysOfMonth.includes(date.day);
  const byWeekday = fields.weekdays.includes(localWeekday(date));
  if (fields.dayOfMonthRestricted && fields.weekdayRestricted) return byDay || byWeekday;
  if (fields.dayOfMonthRestricted) return byDay;
  if (fields.weekdayRestricted) return byWeekday;
  return true;
}
