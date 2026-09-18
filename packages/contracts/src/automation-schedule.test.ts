import { describe, expect, it } from 'vitest';

import {
  type AutomationSchedule,
  automationScheduleOf,
  nextAutomationRun,
  parseCron,
} from './automation-schedule';

/**
 * The next-run calculation (issue #73).
 *
 * Worth testing exhaustively because nothing else can catch it being wrong: a
 * rule with a bad schedule does not fail, it runs at the wrong time, once, in
 * the night, and the only evidence is a log entry with an odd timestamp.
 */

const BERLIN = 'Europe/Berlin';

function schedule(overrides: Partial<AutomationSchedule>): AutomationSchedule {
  return {
    kind: 'DAILY',
    at: null,
    time: '07:00',
    weekday: null,
    dayOfMonth: null,
    cron: null,
    timeZone: BERLIN,
    ...overrides,
  };
}

/** What a wall clock in `timeZone` shows, as `YYYY-MM-DD HH:MM`. */
function localOf(instant: Date, timeZone = BERLIN): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

describe('nextAutomationRun', () => {
  it('finds today for a daily schedule that has not passed yet', () => {
    const next = nextAutomationRun(schedule({}), new Date('2026-03-10T04:00:00.000Z'));
    // 05:00 UTC is 06:00 in Berlin in winter, so 07:00 is still ahead.
    expect(localOf(next!)).toBe('2026-03-10 07:00');
  });

  it('moves to tomorrow once the time of day has passed', () => {
    const next = nextAutomationRun(schedule({}), new Date('2026-03-10T09:00:00.000Z'));
    expect(localOf(next!)).toBe('2026-03-11 07:00');
  });

  it('is strictly after the moment it is asked about', () => {
    const at = new Date('2026-03-10T06:00:00.000Z');
    expect(localOf(at)).toBe('2026-03-10 07:00');
    const next = nextAutomationRun(schedule({}), at);
    expect(localOf(next!)).toBe('2026-03-11 07:00');
  });

  it('keeps the wall-clock time across a daylight saving change', () => {
    // Germany moves to summer time in the night of 29 March 2026.
    const before = nextAutomationRun(schedule({}), new Date('2026-03-28T09:00:00.000Z'));
    expect(localOf(before!)).toBe('2026-03-29 07:00');
    // The same local time, an hour earlier in UTC than the day before.
    expect(before!.toISOString()).toBe('2026-03-29T05:00:00.000Z');
  });

  it('finds the next weekday for a weekly schedule', () => {
    // 10 March 2026 is a Tuesday; weekday 0 is Sunday.
    const next = nextAutomationRun(
      schedule({ kind: 'WEEKLY', weekday: 0, time: '18:30' }),
      new Date('2026-03-10T09:00:00.000Z'),
    );
    expect(localOf(next!)).toBe('2026-03-15 18:30');
  });

  it('clamps a monthly day to the last day of a shorter month', () => {
    const next = nextAutomationRun(
      schedule({ kind: 'MONTHLY', dayOfMonth: 31, time: '05:00' }),
      new Date('2026-02-01T09:00:00.000Z'),
    );
    expect(localOf(next!)).toBe('2026-02-28 05:00');
  });

  it('answers a one-off in the future and nothing once it has passed', () => {
    const moment = new Date('2026-04-01T10:00:00.000Z');
    const once = schedule({ kind: 'ONCE', at: moment, time: null });
    expect(nextAutomationRun(once, new Date('2026-03-31T10:00:00.000Z'))).toEqual(moment);
    expect(nextAutomationRun(once, new Date('2026-04-01T10:00:00.000Z'))).toBeNull();
  });

  it('reads a cron expression in the rule’s own zone', () => {
    const next = nextAutomationRun(
      schedule({ kind: 'CRON', cron: '30 6 * * 1', time: null }),
      new Date('2026-03-10T09:00:00.000Z'),
    );
    // The Monday after that Tuesday, half past six local.
    expect(localOf(next!)).toBe('2026-03-16 06:30');
  });

  it('honours steps and lists in a cron expression', () => {
    const every = schedule({ kind: 'CRON', cron: '0,30 */6 * * *', time: null });
    const first = nextAutomationRun(every, new Date('2026-03-10T09:05:00.000Z'));
    expect(localOf(first!)).toBe('2026-03-10 12:00');
    const second = nextAutomationRun(every, first!);
    expect(localOf(second!)).toBe('2026-03-10 12:30');
  });

  it('treats the two day fields of a cron expression as an or', () => {
    // The first of the month, and every Monday.
    const next = nextAutomationRun(
      schedule({ kind: 'CRON', cron: '0 5 1 * 1', time: null }),
      new Date('2026-03-10T09:00:00.000Z'),
    );
    expect(localOf(next!)).toBe('2026-03-16 05:00');
  });

  it('answers a schedule in a different zone in that zone', () => {
    const next = nextAutomationRun(
      schedule({ timeZone: 'Pacific/Auckland', time: '07:00' }),
      new Date('2026-03-10T09:00:00.000Z'),
    );
    expect(localOf(next!, 'Pacific/Auckland')).toBe('2026-03-11 07:00');
  });

  it('refuses to guess when the fields the kind needs are missing', () => {
    expect(nextAutomationRun(schedule({ kind: 'WEEKLY', weekday: null }), new Date())).toBeNull();
    expect(nextAutomationRun(schedule({ kind: 'CRON', cron: 'nonsense' }), new Date())).toBeNull();
    expect(nextAutomationRun(schedule({ time: null }), new Date())).toBeNull();
  });
});

describe('parseCron', () => {
  it('accepts the shapes the dialect promises', () => {
    expect(parseCron('0 5 * * *')?.hours).toEqual([5]);
    expect(parseCron('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron('0 1-3 * * *')?.hours).toEqual([1, 2, 3]);
    expect(parseCron('0 0 * * 7')?.weekdays).toEqual([0]);
    expect(parseCron('0 0 1 1 *')?.dayOfMonthRestricted).toBe(true);
  });

  it('refuses everything it does not understand rather than guessing', () => {
    expect(parseCron('0 0 * *')).toBeNull();
    expect(parseCron('@daily')).toBeNull();
    expect(parseCron('0 0 * * MON')).toBeNull();
    expect(parseCron('0 99 * * *')).toBeNull();
    expect(parseCron('0 0 L * *')).toBeNull();
    expect(parseCron('0 5-1 * * *')).toBeNull();
  });
});

describe('automationScheduleOf', () => {
  it('answers null while the row carries no schedule', () => {
    expect(
      automationScheduleOf({
        scheduleKind: null,
        scheduleAt: null,
        scheduleTime: null,
        scheduleWeekday: null,
        scheduleDayOfMonth: null,
        scheduleCron: null,
        scheduleTimeZone: null,
      }),
    ).toBeNull();
  });

  it('reads an ISO string as the instant it is', () => {
    const result = automationScheduleOf({
      scheduleKind: 'ONCE',
      scheduleAt: '2026-04-01T10:00:00.000Z',
      scheduleTime: null,
      scheduleWeekday: null,
      scheduleDayOfMonth: null,
      scheduleCron: null,
      scheduleTimeZone: BERLIN,
    });
    expect(result?.at?.toISOString()).toBe('2026-04-01T10:00:00.000Z');
  });
});
