import { describe, expect, it } from 'vitest';

import { buildReminderMessage, type ReminderContext } from './reminder-message';

const context: ReminderContext = {
  title: 'Zahnarzt',
  location: null,
  url: null,
  timeZone: 'Europe/Berlin',
  now: new Date('2026-08-20T13:32:00.000Z'),
};

describe('buildReminderMessage', () => {
  it('names the remaining minutes and the local times', () => {
    const message = buildReminderMessage(
      {
        start: new Date('2026-08-20T14:00:00.000Z'),
        end: new Date('2026-08-20T15:00:00.000Z'),
        allDay: false,
      },
      context,
    );

    // 14:00Z is 16:00 in Berlin, and the countdown is the real remainder.
    expect(message).toBe('🔔 In 28 Minuten: Zahnarzt\n16:00 bis 17:00 Uhr');
  });

  it('says "jetzt" once the appointment has started', () => {
    const message = buildReminderMessage(
      { start: new Date('2026-08-20T13:30:00.000Z'), end: null, allDay: false },
      context,
    );

    expect(message.startsWith('🔔 Jetzt: Zahnarzt')).toBe(true);
    // No end means a point in time, so only one clock reading is given.
    expect(message).toContain('15:30 Uhr');
    expect(message).not.toContain('bis');
  });

  it('counts in hours when the lead time is long', () => {
    const message = buildReminderMessage(
      { start: new Date('2026-08-20T16:02:00.000Z'), end: null, allDay: false },
      context,
    );

    expect(message.startsWith('🔔 In 2 Stunden 30 Minuten: Zahnarzt')).toBe(true);
  });

  it('uses the singular for exactly one hour and one minute', () => {
    expect(
      buildReminderMessage(
        { start: new Date('2026-08-20T14:32:00.000Z'), end: null, allDay: false },
        context,
      ).startsWith('🔔 In einer Stunde: '),
    ).toBe(true);
    expect(
      buildReminderMessage(
        { start: new Date('2026-08-20T13:33:00.000Z'), end: null, allDay: false },
        context,
      ).startsWith('🔔 In einer Minute: '),
    ).toBe(true);
  });

  it('appends the location and the link', () => {
    const message = buildReminderMessage(
      {
        start: new Date('2026-08-20T14:00:00.000Z'),
        end: new Date('2026-08-20T15:00:00.000Z'),
        allDay: false,
      },
      { ...context, location: 'Praxis Mitte', url: 'https://exocortex.app/x' },
    );

    expect(message).toBe(
      '🔔 In 28 Minuten: Zahnarzt\n16:00 bis 17:00 Uhr · Praxis Mitte\nhttps://exocortex.app/x',
    );
  });

  it('says "heute" and "ganztägig" for an all-day appointment', () => {
    const message = buildReminderMessage(
      {
        start: new Date('2026-08-20T00:00:00.000Z'),
        end: new Date('2026-08-21T00:00:00.000Z'),
        allDay: true,
      },
      { ...context, title: 'Jahrestag erstes Treffen, 2022' },
    );

    expect(message).toBe('🔔 Heute: Jahrestag erstes Treffen, 2022\nGanztägig');
  });

  it('names the real last day of a multi-day all-day appointment', () => {
    const message = buildReminderMessage(
      {
        // Exclusive end: the appointment covers the 20th to the 22nd.
        start: new Date('2026-08-20T00:00:00.000Z'),
        end: new Date('2026-08-23T00:00:00.000Z'),
        allDay: true,
      },
      { ...context, title: 'Urlaub' },
    );

    expect(message).toBe('🔔 Heute: Urlaub\nGanztägig, 20.08.2026 bis 22.08.2026');
  });

  it('spells out an end that falls on another day', () => {
    const message = buildReminderMessage(
      {
        start: new Date('2026-08-20T21:00:00.000Z'),
        end: new Date('2026-08-21T01:00:00.000Z'),
        allDay: false,
      },
      { ...context, title: 'Nachtschicht' },
    );

    // 23:00 Berlin to 03:00 the next day: a bare "bis 03:00" would be ambiguous.
    expect(message).toContain('23:00 Uhr bis 21.08.2026, 03:00 Uhr');
  });
});
