import { describe, expect, it } from 'vitest';

import { isDue, type ReminderSchedule, reminderWindowFor } from './reminder-time';

const BERLIN: ReminderSchedule = { leadMinutes: 30, allDayHour: 9, timeZone: 'Europe/Berlin' };

describe('reminderWindowFor, timed appointments', () => {
  it('opens the window the lead time before the start', () => {
    const window = reminderWindowFor(
      { start: new Date('2026-08-20T14:00:00.000Z'), allDay: false },
      BERLIN,
    );

    expect(window.due.toISOString()).toBe('2026-08-20T13:30:00.000Z');
    // A reminder that arrives slightly late still says something true.
    expect(window.expires.toISOString()).toBe('2026-08-20T14:15:00.000Z');
  });

  it('fires at the start itself when the lead time is zero', () => {
    const window = reminderWindowFor(
      { start: new Date('2026-08-20T14:00:00.000Z'), allDay: false },
      { ...BERLIN, leadMinutes: 0 },
    );

    expect(window.due.toISOString()).toBe('2026-08-20T14:00:00.000Z');
  });

  it('is due inside the window and not outside it', () => {
    const window = reminderWindowFor(
      { start: new Date('2026-08-20T14:00:00.000Z'), allDay: false },
      BERLIN,
    );

    expect(isDue(window, new Date('2026-08-20T13:29:59.000Z'))).toBe(false);
    expect(isDue(window, new Date('2026-08-20T13:30:00.000Z'))).toBe(true);
    expect(isDue(window, new Date('2026-08-20T14:14:00.000Z'))).toBe(true);
    // An hour late is no longer a reminder, it is noise.
    expect(isDue(window, new Date('2026-08-20T15:00:00.000Z'))).toBe(false);
  });
});

describe('reminderWindowFor, all-day appointments', () => {
  it('announces at the configured local hour of that date, in summer time', () => {
    // A floating date at UTC midnight. 09:00 in Berlin is 07:00Z while CEST holds.
    const window = reminderWindowFor(
      { start: new Date('2026-08-17T00:00:00.000Z'), allDay: true },
      BERLIN,
    );

    expect(window.due.toISOString()).toBe('2026-08-17T07:00:00.000Z');
    // Valid until the local day is over: 00:00 Berlin on the 18th is 22:00Z.
    expect(window.expires.toISOString()).toBe('2026-08-17T22:00:00.000Z');
  });

  it('shifts by an hour in winter time, which is the whole point of the zone', () => {
    const window = reminderWindowFor(
      { start: new Date('2026-01-17T00:00:00.000Z'), allDay: true },
      BERLIN,
    );

    expect(window.due.toISOString()).toBe('2026-01-17T08:00:00.000Z');
    expect(window.expires.toISOString()).toBe('2026-01-17T23:00:00.000Z');
  });

  it('lands on the right side of the day the clocks change', () => {
    // 2026-03-29 is the spring transition in Europe/Berlin: 02:00 becomes 03:00.
    // The naive one-pass correction can land on the wrong offset here.
    const window = reminderWindowFor(
      { start: new Date('2026-03-29T00:00:00.000Z'), allDay: true },
      BERLIN,
    );

    // 09:00 local on that date is CEST, so 07:00Z.
    expect(window.due.toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('is not due before the hour, and not the following morning', () => {
    const window = reminderWindowFor(
      { start: new Date('2026-08-17T00:00:00.000Z'), allDay: true },
      BERLIN,
    );

    expect(isDue(window, new Date('2026-08-17T05:00:00.000Z'))).toBe(false);
    expect(isDue(window, new Date('2026-08-17T07:00:00.000Z'))).toBe(true);
    expect(isDue(window, new Date('2026-08-17T20:00:00.000Z'))).toBe(true);
    // A birthday announced the next morning is wrong, not late.
    expect(isDue(window, new Date('2026-08-18T06:00:00.000Z'))).toBe(false);
  });

  it('works in a zone far enough ahead of UTC to move the announcement backwards', () => {
    // 09:00 in Auckland on the 17th is 21:00Z on the *16th*: earlier than the
    // stored start. A window built from the lead time alone would miss this.
    const window = reminderWindowFor(
      { start: new Date('2026-08-17T00:00:00.000Z'), allDay: true },
      { ...BERLIN, timeZone: 'Pacific/Auckland' },
    );

    expect(window.due.toISOString()).toBe('2026-08-16T21:00:00.000Z');
    expect(window.due.getTime()).toBeLessThan(new Date('2026-08-17T00:00:00.000Z').getTime());
  });
});
