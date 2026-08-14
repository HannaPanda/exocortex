import { describe, expect, it } from 'vitest';

import { parseCalendarObject } from './ics';
import { buildEventIcs, patchEventIcs } from './ics-write';
import { type CalendarEventPayload, hashCalendarEventPayload } from './payload';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function payload(overrides: Partial<CalendarEventPayload> = {}): CalendarEventPayload {
  return {
    uid: 'event-1@exocortex',
    summary: 'Zahnarzt',
    description: null,
    location: null,
    start: '2026-08-17T08:30:00.000Z',
    end: '2026-08-17T09:30:00.000Z',
    allDay: false,
    ...overrides,
  };
}

describe('buildEventIcs', () => {
  it('writes a timed event as a UTC instant', () => {
    const ics = buildEventIcs(payload(), { now: NOW });

    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:event-1@exocortex');
    expect(ics).toContain('DTSTART:20260817T083000Z');
    expect(ics).toContain('DTEND:20260817T093000Z');
    expect(ics).toContain('DTSTAMP:20260808T120000Z');
    expect(ics).toContain('SEQUENCE:0');
    // Every line ends with CRLF, the last one included.
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('writes an all-day event as a DATE with an exclusive end', () => {
    const ics = buildEventIcs(
      payload({ start: '2026-08-17T00:00:00.000Z', end: null, allDay: true }),
      { now: NOW },
    );

    expect(ics).toContain('DTSTART;VALUE=DATE:20260817');
    // One day long, so the end is the following date: how iCalendar spells it.
    expect(ics).toContain('DTEND;VALUE=DATE:20260818');
  });

  it('omits DTEND for a point in time', () => {
    const ics = buildEventIcs(payload({ end: null }), { now: NOW });

    expect(ics).not.toContain('DTEND');
    // And it reads back as the null it came from.
    const parsed = parseCalendarObject(ics);
    expect(parsed.events[0]?.end).toBeNull();
  });

  it('leaves an empty location and description out entirely', () => {
    const ics = buildEventIcs(payload({ location: '   ', description: '' }), { now: NOW });

    expect(ics).not.toContain('LOCATION');
    expect(ics).not.toContain('DESCRIPTION');
  });

  it('survives the round trip through the reader, commas included', () => {
    const original = payload({
      summary: 'Jahrestag, erstes Treffen; 2022',
      description: 'Zeile eins\nZeile zwei',
      location: 'Café Größenwahn, Berlin',
    });

    const parsed = parseCalendarObject(buildEventIcs(original, { now: NOW }));
    const event = parsed.events[0];

    expect(event?.summary).toBe('Jahrestag, erstes Treffen; 2022');
    expect(event?.description).toBe('Zeile eins\nZeile zwei');
    expect(event?.location).toBe('Café Größenwahn, Berlin');
    expect(event?.start).toBe(original.start);
    expect(event?.end).toBe(original.end);
  });

  it('hashes the round trip to the same fingerprint, so an echo is no change', () => {
    const original = payload({ location: 'Praxis' });
    const parsed = parseCalendarObject(buildEventIcs(original, { now: NOW }));
    const event = parsed.events[0];

    expect(event).toBeDefined();
    expect(hashCalendarEventPayload({ ...original, ...event! })).toBe(
      hashCalendarEventPayload(original),
    );
  });
});

/** A body as a real server stores it: authored in a zone, with an alarm. */
const REMOTE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//mailbox.org//CalDAV//DE',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:event-1@exocortex',
  'SUMMARY:Zahnarzt',
  'DTSTART;TZID=Europe/Berlin:20260817T103000',
  'DTEND;TZID=Europe/Berlin:20260817T113000',
  'CATEGORIES:Gesundheit',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:johanna@example.org',
  'SEQUENCE:2',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('patchEventIcs', () => {
  it('keeps everything it does not own', () => {
    const patched = patchEventIcs(REMOTE_ICS, payload({ summary: 'Zahnarzt, verschoben' }), {
      now: NOW,
    });

    expect(patched).not.toBeNull();
    expect(patched).toContain('SUMMARY:Zahnarzt\\, verschoben');
    // The alarm is the reason this patches instead of rebuilding: rebuilding
    // would delete the reminder that fires on someone's phone.
    expect(patched).toContain('BEGIN:VALARM');
    expect(patched).toContain('TRIGGER:-PT15M');
    expect(patched).toContain('CATEGORIES:Gesundheit');
    expect(patched).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:johanna@example.org');
    expect(patched).toContain('BEGIN:VTIMEZONE');
  });

  it('replaces the start without leaving the old zone on it', () => {
    const patched = patchEventIcs(REMOTE_ICS, payload(), { now: NOW });

    expect(patched).toContain('DTSTART:20260817T083000Z');
    // The bug this guards: updating the property in place kept `TZID=` next to a
    // UTC value, which no client resolves the same way twice.
    expect(patched).not.toContain('TZID=Europe/Berlin:2026');
    expect(patched).toContain('LAST-MODIFIED:20260808T120000Z');
  });

  it('bumps SEQUENCE so an invited client accepts the new version', () => {
    const patched = patchEventIcs(REMOTE_ICS, payload(), { now: NOW });

    expect(patched).toContain('SEQUENCE:3');
  });

  it('drops a DURATION when it writes a DTEND', () => {
    const withDuration = REMOTE_ICS.replace(
      'DTEND;TZID=Europe/Berlin:20260817T113000',
      'DURATION:PT1H',
    );

    const patched = patchEventIcs(withDuration, payload(), { now: NOW });

    expect(patched).not.toContain('DURATION');
    expect(patched).toContain('DTEND:20260817T093000Z');
  });

  it('returns null when the body holds no event with that UID', () => {
    expect(
      patchEventIcs(REMOTE_ICS, payload({ uid: 'somebody-else@example.org' }), { now: NOW }),
    ).toBeNull();
  });

  it('reads back as the payload that went in', () => {
    const target = payload({ summary: 'Zahnarzt', location: 'Praxis Mitte', end: null });
    const patched = patchEventIcs(REMOTE_ICS, target, { now: NOW });

    const event = parseCalendarObject(patched ?? '').events[0];
    expect(event?.summary).toBe('Zahnarzt');
    expect(event?.location).toBe('Praxis Mitte');
    expect(event?.start).toBe(target.start);
    expect(event?.end).toBeNull();
  });
});

describe('hashCalendarEventPayload', () => {
  it('treats an empty string and an absent value as the same', () => {
    expect(hashCalendarEventPayload(payload({ location: '' }))).toBe(
      hashCalendarEventPayload(payload({ location: null })),
    );
  });

  it('treats two spellings of one instant as the same', () => {
    expect(hashCalendarEventPayload(payload({ start: '2026-08-17T08:30:00Z' }))).toBe(
      hashCalendarEventPayload(payload({ start: '2026-08-17T08:30:00.000Z' })),
    );
  });

  it('ignores the UID, which identifies rather than describes', () => {
    expect(hashCalendarEventPayload(payload({ uid: 'other@exocortex' }))).toBe(
      hashCalendarEventPayload(payload()),
    );
  });

  it('changes when a field a human can edit changes', () => {
    const base = hashCalendarEventPayload(payload());
    expect(hashCalendarEventPayload(payload({ summary: 'Zahnarzt (neu)' }))).not.toBe(base);
    expect(hashCalendarEventPayload(payload({ end: '2026-08-17T10:00:00.000Z' }))).not.toBe(base);
    expect(hashCalendarEventPayload(payload({ allDay: true }))).not.toBe(base);
  });
});
