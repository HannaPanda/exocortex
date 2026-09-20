/**
 * Wall-clock arithmetic in an IANA zone, with no dependency.
 *
 * Three places in this repository have to answer the same question -- what
 * instant is "07:00 in Europe/Berlin", and what does a clock there show right
 * now: scheduled automations (`automation-schedule.ts`), appointment reminders
 * (`apps/worker/src/calendar/reminder-time.ts`) and the daily comment digest
 * (issue #106). They used to answer it with two copies of the same two-pass
 * offset trick, and a third copy is how the one that got the spring-forward
 * hour wrong would have gone unnoticed.
 *
 * `Intl` is the only zone database available, and it is the authority here: a
 * zone it does not know is refused at the boundary rather than guessed at.
 */

/** A calendar date without a zone: what a wall clock shows. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
}

/** Whether the runtime knows the zone. */
export function isUsableTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** What a wall clock in `timeZone` shows at this instant. */
export function localTimeParts(instant: Date, timeZone: string): LocalDateTime {
  const parts = zoneParts(instant, timeZone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/**
 * The instant at which a wall clock in `timeZone` shows this local time.
 *
 * Two passes: the first offset is read at the wrong instant by up to an hour
 * around a transition, and applying it lands close enough for the second to be
 * right. A local time that does not exist (the hour a zone skips in spring) is
 * pushed forward rather than dropped, and one that exists twice resolves to
 * the first -- both are answers, and a caller that cares compares the result
 * against what it asked for.
 */
export function instantAtLocalTime(local: LocalDateTime, timeZone: string): Date {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
export function offsetMs(instant: Date, timeZone: string): number {
  const parts = zoneParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

/** The same local date, moved by whole days. Pure calendar arithmetic. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  };
}

/** 0 is Sunday, 6 is Saturday, the way `Date` counts. */
export function localWeekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function zoneParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value ?? '0';
    return Number.parseInt(value, 10);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` renders midnight as 24 in some runtimes, which would push
    // the date forward by a day.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The most recent instant at which a clock in `timeZone` struck `hour:00`, at
 * or before `now` (issue #106).
 *
 * What a daily digest compares against. Not "midnight plus n hours" and not
 * "now minus 24 hours": a day in a zone that changes its clocks is 23 or 25
 * hours long, and both of those readings would skip or repeat a slot on
 * exactly the two days a year nobody tests.
 */
export function lastLocalHourSlot(now: Date, hour: number, timeZone: string): Date {
  const local = localTimeParts(now, timeZone);
  const day = local.hour >= hour ? local : addLocalDays(local, -1);
  const slot = instantAtLocalTime({ ...day, hour, minute: 0 }, timeZone);
  // The skipped hour in spring pushes the conversion forward, which can land
  // after `now`. A slot in the future has not happened, so step back a day.
  if (slot.getTime() > now.getTime()) {
    return instantAtLocalTime({ ...addLocalDays(day, -1), hour, minute: 0 }, timeZone);
  }
  return slot;
}
