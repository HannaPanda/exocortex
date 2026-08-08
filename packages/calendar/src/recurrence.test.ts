import { describe, expect, it } from 'vitest';

import { describeRecurrence, resolveOccurrence } from './recurrence';

/**
 * The fixtures mirror the shapes mailbox.org returns (a yearly all-day event, a
 * weekly timed series with a moved instance) with invented content.
 */

function calendar(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join(
    '\r\n',
  );
}

const YEARLY_ALL_DAY = calendar(
  'BEGIN:VEVENT',
  'UID:yearly@example.org',
  'SUMMARY:Jahrestag',
  'DTSTART;VALUE=DATE:20220817',
  'DTEND;VALUE=DATE:20220818',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
);

const WEEKLY_TIMED = calendar(
  'BEGIN:VEVENT',
  'UID:weekly@example.org',
  'SUMMARY:Standup',
  'DTSTART:20260803T080000Z',
  'DTEND:20260803T083000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
);

const WEEKLY_WITH_OVERRIDE = calendar(
  'BEGIN:VEVENT',
  'UID:weekly@example.org',
  'SUMMARY:Standup',
  'DTSTART:20260803T080000Z',
  'DTEND:20260803T083000Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly@example.org',
  'SUMMARY:Standup (später)',
  'RECURRENCE-ID:20260810T080000Z',
  'DTSTART:20260810T140000Z',
  'DTEND:20260810T150000Z',
  'END:VEVENT',
);

describe('resolveOccurrence', () => {
  it('returns the next occurrence of a yearly series, not its first', () => {
    const occurrence = resolveOccurrence(YEARLY_ALL_DAY, { from: new Date('2026-08-08T10:00:00Z') });

    // The series starts in 2022; what belongs in the table is 2026.
    expect(occurrence?.start).toBe('2026-08-17T00:00:00.000Z');
    expect(occurrence?.end).toBe('2026-08-18T00:00:00.000Z');
    expect(occurrence?.allDay).toBe(true);
    expect(occurrence?.isFinal).toBe(false);
  });

  it('keeps an all-day occurrence current for the whole day', () => {
    // Late in the evening of the day itself: the exclusive end is the next
    // midnight, so today still wins over next year.
    const occurrence = resolveOccurrence(YEARLY_ALL_DAY, { from: new Date('2026-08-17T22:00:00Z') });

    expect(occurrence?.start).toBe('2026-08-17T00:00:00.000Z');
  });

  it('keeps a timed occurrence current while it runs', () => {
    const occurrence = resolveOccurrence(WEEKLY_TIMED, { from: new Date('2026-08-10T08:10:00Z') });

    expect(occurrence?.start).toBe('2026-08-10T08:00:00.000Z');
  });

  it('moves on once the occurrence has ended', () => {
    const occurrence = resolveOccurrence(WEEKLY_TIMED, { from: new Date('2026-08-10T08:30:00Z') });

    expect(occurrence?.start).toBe('2026-08-17T08:00:00.000Z');
  });

  it('applies a moved instance instead of the rule slot', () => {
    const occurrence = resolveOccurrence(WEEKLY_WITH_OVERRIDE, {
      from: new Date('2026-08-09T00:00:00Z'),
    });

    expect(occurrence?.start).toBe('2026-08-10T14:00:00.000Z');
    expect(occurrence?.end).toBe('2026-08-10T15:00:00.000Z');
    expect(occurrence?.overridden).toBe(true);
    // The rule's untouched slot, which is what identifies the instance remotely.
    expect(occurrence?.recurrenceId).toBe('2026-08-10T08:00:00.000Z');
  });

  it('skips a date the series excludes', () => {
    const withExdate = calendar(
      'BEGIN:VEVENT',
      'UID:weekly@example.org',
      'DTSTART:20260803T080000Z',
      'DTEND:20260803T083000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE:20260810T080000Z',
      'END:VEVENT',
    );

    const occurrence = resolveOccurrence(withExdate, { from: new Date('2026-08-09T00:00:00Z') });

    expect(occurrence?.start).toBe('2026-08-17T08:00:00.000Z');
  });

  it('returns the last occurrence of a finished series and marks it final', () => {
    const ended = calendar(
      'BEGIN:VEVENT',
      'UID:ended@example.org',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'END:VEVENT',
    );

    // A series that is over keeps the date it ended on. An empty cell would look
    // like the sync had lost the appointment.
    const occurrence = resolveOccurrence(ended, { from: new Date('2026-08-08T00:00:00Z') });

    expect(occurrence?.start).toBe('2026-06-15T09:00:00.000Z');
    expect(occurrence?.isFinal).toBe(true);
  });

  it('marks the last occurrence of a bounded series as final while it is still ahead', () => {
    const ending = calendar(
      'BEGIN:VEVENT',
      'UID:ending@example.org',
      'DTSTART:20260803T090000Z',
      'DTEND:20260803T100000Z',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'END:VEVENT',
    );

    const occurrence = resolveOccurrence(ending, { from: new Date('2026-08-05T00:00:00Z') });

    expect(occurrence?.start).toBe('2026-08-10T09:00:00.000Z');
    expect(occurrence?.isFinal).toBe(true);
  });

  it('returns the single instant of an event that does not recur', () => {
    const single = calendar(
      'BEGIN:VEVENT',
      'UID:single@example.org',
      'DTSTART:20260901T090000Z',
      'DTEND:20260901T100000Z',
      'END:VEVENT',
    );

    const occurrence = resolveOccurrence(single, { from: new Date('2026-08-08T00:00:00Z') });

    expect(occurrence).toEqual({
      start: '2026-09-01T09:00:00.000Z',
      end: '2026-09-01T10:00:00.000Z',
      allDay: false,
      recurrenceId: null,
      overridden: false,
      isFinal: true,
    });
  });

  it('reports a timed occurrence without DTEND as a point in time', () => {
    const pointInTime = calendar(
      'BEGIN:VEVENT',
      'UID:point@example.org',
      'DTSTART:20260803T090000Z',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
    );

    const occurrence = resolveOccurrence(pointInTime, { from: new Date('2026-08-09T00:00:00Z') });

    expect(occurrence?.start).toBe('2026-08-10T09:00:00.000Z');
    // Not "ends the moment it starts", which is what ical.js would say.
    expect(occurrence?.end).toBeNull();
  });

  it('resolves a series in a named zone through that zone', () => {
    const berlin = calendar(
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:DAYLIGHT',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0200',
      'TZNAME:CEST',
      'DTSTART:19700329T020000',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'TZNAME:CET',
      'DTSTART:19701025T030000',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:berlin@example.org',
      'DTSTART;TZID=Europe/Berlin:20260803T100000',
      'DTEND;TZID=Europe/Berlin:20260803T110000',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
    );

    const occurrence = resolveOccurrence(berlin, { from: new Date('2026-08-09T00:00:00Z') });

    // 10:00 in summer Berlin is 08:00 UTC, and it stays 10:00 local in winter.
    expect(occurrence?.start).toBe('2026-08-10T08:00:00.000Z');
  });

  it('returns null for an object that holds only an override', () => {
    const orphan = calendar(
      'BEGIN:VEVENT',
      'UID:weekly@example.org',
      'RECURRENCE-ID:20260810T080000Z',
      'DTSTART:20260810T140000Z',
      'END:VEVENT',
    );

    expect(resolveOccurrence(orphan, { from: new Date('2026-08-09T00:00:00Z') })).toBeNull();
  });
});

describe('describeRecurrence', () => {
  it('names the plain frequencies in German', () => {
    expect(describeRecurrence('FREQ=DAILY')).toBe('täglich');
    expect(describeRecurrence('FREQ=WEEKLY')).toBe('wöchentlich');
    expect(describeRecurrence('FREQ=MONTHLY')).toBe('monatlich');
    expect(describeRecurrence('FREQ=YEARLY;INTERVAL=1')).toBe('jährlich');
  });

  it('spells out an interval and the weekdays', () => {
    expect(describeRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toBe(
      'alle 2 Wochen (Di, Do)',
    );
  });

  it('reads an ordinal weekday', () => {
    expect(describeRecurrence('FREQ=MONTHLY;BYDAY=-1FR')).toBe('monatlich (letzter Fr)');
    expect(describeRecurrence('FREQ=MONTHLY;BYDAY=2MO')).toBe('monatlich (2. Mo)');
  });

  it('appends the end of the series', () => {
    expect(describeRecurrence('FREQ=YEARLY;UNTIL=20301231T235959Z')).toBe('jährlich, bis 31.12.2030');
    expect(describeRecurrence('FREQ=WEEKLY;COUNT=5')).toBe('wöchentlich, 5 Mal');
  });

  it('falls back to the raw rule it cannot describe', () => {
    expect(describeRecurrence('FREQ=SECONDLY;INTERVAL=30')).toBe('FREQ=SECONDLY;INTERVAL=30');
  });
});
