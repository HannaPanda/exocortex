import { describe, expect, it } from 'vitest';

import { parseCalendarObject } from './ics';

/**
 * The fixtures mirror the *shapes* mailbox.org actually returned during the
 * first connection test (a yearly all-day event with an escaped comma in its
 * summary, and a VTODO with no DUE), with invented content: a test fixture must
 * not carry someone's real appointments.
 */

const YEARLY_ALL_DAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:yearly-all-day@example.org',
  'SUMMARY:Jahrestag erstes Treffen\\, 2022',
  'DTSTART;VALUE=DATE:20250817',
  'DTEND;VALUE=DATE:20250818',
  'RRULE:FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=17',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const TIMED_BERLIN = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
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
  'UID:timed@example.org',
  'SUMMARY:Zahnarzt',
  'DTSTART;TZID=Europe/Berlin:20260820T100000',
  'DTEND;TZID=Europe/Berlin:20260820T110000',
  'LAST-MODIFIED:20260801T120000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const INVITATION = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:invite@example.org',
  'SUMMARY:Projekt-Kickoff',
  'DTSTART:20260901T090000Z',
  'DTEND:20260901T100000Z',
  'SEQUENCE:3',
  'ORGANIZER;CN=Chef:mailto:chef@example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Ich:mailto:Johanna@Example.NET',
  'ATTENDEE;PARTSTAT=DECLINED;CN=Andere:mailto:andere@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseCalendarObject: all-day events', () => {
  it('pins an all-day date to UTC midnight so it cannot drift by a zone', () => {
    const { events } = parseCalendarObject(YEARLY_ALL_DAY);
    expect(events).toHaveLength(1);
    expect(events[0]?.allDay).toBe(true);
    expect(events[0]?.start).toBe('2025-08-17T00:00:00.000Z');
    // Exclusive end, exactly as the server wrote it.
    expect(events[0]?.end).toBe('2025-08-18T00:00:00.000Z');
  });

  it('unescapes a comma in the summary', () => {
    const { events } = parseCalendarObject(YEARLY_ALL_DAY);
    expect(events[0]?.summary).toBe('Jahrestag erstes Treffen, 2022');
  });

  it('keeps the recurrence rule as text instead of expanding it', () => {
    const { events } = parseCalendarObject(YEARLY_ALL_DAY);
    expect(events[0]?.rrule).toBe('FREQ=YEARLY;BYMONTH=8;BYMONTHDAY=17');
    expect(events[0]?.recurrenceId).toBeNull();
  });

  it('defaults a bare all-day event to one day', () => {
    const withoutEnd = YEARLY_ALL_DAY.replace('DTEND;VALUE=DATE:20250818\r\n', '');
    const { events } = parseCalendarObject(withoutEnd);
    expect(events[0]?.end).toBe('2025-08-18T00:00:00.000Z');
  });
});

describe('parseCalendarObject: timed events', () => {
  it('converts a zoned time to the right instant', () => {
    const { events } = parseCalendarObject(TIMED_BERLIN);
    // 10:00 Berlin in August is CEST, so 08:00 UTC. Getting this wrong by an
    // hour is the classic calendar bug.
    expect(events[0]?.start).toBe('2026-08-20T08:00:00.000Z');
    expect(events[0]?.end).toBe('2026-08-20T09:00:00.000Z');
    expect(events[0]?.allDay).toBe(false);
  });

  it('records the authoring zone, not the resolved offset', () => {
    const { events } = parseCalendarObject(TIMED_BERLIN);
    expect(events[0]?.timeZone).toBe('Europe/Berlin');
    expect(events[0]?.lastModified).toBe('2026-08-01T12:00:00.000Z');
  });

  it('reports a timed event without an end as a point in time', () => {
    const withoutEnd = TIMED_BERLIN.replace('DTEND;TZID=Europe/Berlin:20260820T110000\r\n', '');
    const { events } = parseCalendarObject(withoutEnd);
    expect(events[0]?.end).toBeNull();
  });

  it('applies a DURATION when there is no DTEND', () => {
    const withDuration = TIMED_BERLIN.replace(
      'DTEND;TZID=Europe/Berlin:20260820T110000',
      'DURATION:PT45M',
    );
    const { events } = parseCalendarObject(withDuration);
    expect(events[0]?.end).toBe('2026-08-20T08:45:00.000Z');
  });
});

describe('parseCalendarObject: invitations', () => {
  it('reports the organizer, which is what makes the event not ours to change', () => {
    const { events } = parseCalendarObject(INVITATION);
    expect(events[0]?.organizer).toBe('chef@example.com');
    expect(events[0]?.sequence).toBe(3);
  });

  it('picks our own participation status, not another guest’s', () => {
    const { events } = parseCalendarObject(INVITATION, {
      // Deliberately different case and with a mailto: prefix.
      selfAddresses: ['mailto:johanna@example.net'],
    });
    expect(events[0]?.partStat).toBe('ACCEPTED');
  });

  it('leaves the status null when no attendee is us', () => {
    const { events } = parseCalendarObject(INVITATION, { selfAddresses: ['someone@else.test'] });
    expect(events[0]?.partStat).toBeNull();
  });

  it('has no organizer for a locally created event', () => {
    const { events } = parseCalendarObject(YEARLY_ALL_DAY);
    expect(events[0]?.organizer).toBeNull();
  });
});

describe('parseCalendarObject: todos and multi-component objects', () => {
  const TODO = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'BEGIN:VTODO',
    'UID:todo@example.org',
    'SUMMARY:Rechnung schreiben',
    'STATUS:NEEDS-ACTION',
    'PERCENT-COMPLETE:40',
    'DUE;VALUE=DATE:20260901',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('reads a VTODO with an all-day due date', () => {
    const { todos, events } = parseCalendarObject(TODO);
    expect(events).toHaveLength(0);
    expect(todos[0]).toMatchObject({
      uid: 'todo@example.org',
      summary: 'Rechnung schreiben',
      status: 'NEEDS-ACTION',
      percentComplete: 40,
      due: '2026-09-01T00:00:00.000Z',
      dueAllDay: true,
    });
  });

  it('reads a todo without a due date, which is how they usually arrive', () => {
    const { todos } = parseCalendarObject(TODO.replace('DUE;VALUE=DATE:20260901\r\n', ''));
    expect(todos[0]?.due).toBeNull();
    expect(todos[0]?.dueAllDay).toBe(false);
  });

  it('returns a series and its override from one object, both under the same UID', () => {
    const withOverride = YEARLY_ALL_DAY.replace(
      'END:VCALENDAR',
      [
        'BEGIN:VEVENT',
        'UID:yearly-all-day@example.org',
        'RECURRENCE-ID;VALUE=DATE:20260817',
        'SUMMARY:Jahrestag, verschoben',
        'DTSTART;VALUE=DATE:20260818',
        'DTEND;VALUE=DATE:20260819',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    const { events } = parseCalendarObject(withOverride);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.uid)).toEqual([
      'yearly-all-day@example.org',
      'yearly-all-day@example.org',
    ]);
    // The override is not a second appointment; it replaces one instance.
    expect(events[1]?.recurrenceId).toBe('2026-08-17T00:00:00.000Z');
    expect(events[1]?.rrule).toBeNull();
  });
});
