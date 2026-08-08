/**
 * When a reminder is due, and how long it stays worth sending.
 *
 * Pure functions over instants and one IANA zone name, so every rule here is
 * testable without a database, a clock or a messenger. The zone matters more than
 * it looks: an all-day appointment has no start time to count back from, so it is
 * announced at a *local* hour, and "local" has to survive summer time.
 */

export interface ReminderSchedule {
  /** How long before a timed appointment the reminder goes out. */
  leadMinutes: number;
  /** Local hour at which an all-day appointment is announced. */
  allDayHour: number;
  /** IANA zone the hour above is read in. */
  timeZone: string;
}

/** Half-open window in which a reminder is worth sending: `[due, expires)`. */
export interface ReminderWindow {
  due: Date;
  expires: Date;
}

/**
 * A reminder that arrives after the appointment started is still useful for a
 * while ("you are late"), but one that arrives an hour late is noise.
 */
const TIMED_GRACE_MS = 15 * 60 * 1000;

export function reminderWindowFor(
  span: { start: Date; allDay: boolean },
  schedule: ReminderSchedule,
): ReminderWindow {
  if (!span.allDay) {
    return {
      due: new Date(span.start.getTime() - schedule.leadMinutes * 60_000),
      expires: new Date(span.start.getTime() + TIMED_GRACE_MS),
    };
  }

  // An all-day start is a floating date pinned to UTC midnight (see
  // `toIsoInstant`), so its calendar date is read off the UTC fields and the
  // announcement hour is placed on that date in the configured zone.
  const year = span.start.getUTCFullYear();
  const month = span.start.getUTCMonth() + 1;
  const day = span.start.getUTCDate();
  return {
    due: zonedInstant({ year, month, day, hour: schedule.allDayHour }, schedule.timeZone),
    // Until the day itself is over. Announcing a birthday at 23:00 is late but
    // not wrong; announcing it the next morning is wrong.
    expires: zonedInstant({ year, month, day: day + 1, hour: 0 }, schedule.timeZone),
  };
}

export function isDue(window: ReminderWindow, now: Date): boolean {
  return window.due.getTime() <= now.getTime() && now.getTime() < window.expires.getTime();
}

/**
 * The instant at which the given local wall-clock time occurs in a zone.
 *
 * `Date.UTC` gives the same wall clock read as UTC; subtracting the zone's offset
 * at that moment turns it into the real instant. The correction runs twice
 * because the offset is itself a function of the instant: on the day the clocks
 * change, the first guess can land on the wrong side of the transition. Two
 * passes settle it, and a third would never change anything.
 */
function zonedInstant(
  parts: { year: number; month: number; day: number; hour: number },
  timeZone: string,
): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour);
  let instant = wall - offsetMs(new Date(wall), timeZone);
  instant = wall - offsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * How far ahead of UTC the zone is at that instant, in milliseconds.
 *
 * Read through `Intl` rather than from a timezone library: the zone database the
 * runtime already ships is the same one every other part of this system reads
 * (see `registerTimezones`), and a second copy of it would eventually disagree
 * with the first.
 */
function offsetMs(instant: Date, timeZone: string): number {
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

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // `hour12: false` renders midnight as 24 in some runtimes, which would push
    // the date forward by a day.
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
  return asUtc - instant.getTime();
}
