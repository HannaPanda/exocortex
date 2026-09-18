import { describe, expect, it } from 'vitest';

import { type DatabaseRow } from '@exocortex/contracts';

import { coveredDayKeys, groupEntriesByDay, toCalendarEntries } from './entries';

function row(title: string, value: unknown): DatabaseRow {
  return {
    document: { id: title, title },
    values: [{ propertyId: 'when', value }],
  } as unknown as DatabaseRow;
}

describe('coveredDayKeys', () => {
  it('returns one day for a value with no end', () => {
    expect(coveredDayKeys('2026-09-18T09:00:00.000Z', null, false)).toEqual(['2026-09-18']);
  });

  it('does not bleed into the next day when a span ends at midnight', () => {
    expect(coveredDayKeys('2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z', true)).toEqual([
      '2026-09-18',
    ]);
  });

  it('covers every day of a multi-day span', () => {
    expect(coveredDayKeys('2026-09-18T00:00:00.000Z', '2026-09-21T00:00:00.000Z', true)).toEqual([
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
  });

  it('reads an all-day value off the string rather than converting it', () => {
    // 00:00 UTC is the previous evening west of Greenwich; a birthday still
    // belongs on the date it was written on.
    expect(coveredDayKeys('2026-09-18T00:00:00.000Z', null, true)).toEqual(['2026-09-18']);
  });
});

describe('toCalendarEntries', () => {
  it('reads both DATE response shapes and skips what it cannot plot', () => {
    const entries = toCalendarEntries(
      [
        row('Spanne', { start: '2026-09-18T09:00:00.000Z', end: null, allDay: false }),
        row('Zeitpunkt', '2026-09-18T11:00:00.000Z'),
        row('Leer', null),
      ],
      'when',
    );

    expect(entries.map((entry) => entry.row.document.title)).toEqual(['Spanne', 'Zeitpunkt']);
  });
});

describe('groupEntriesByDay', () => {
  it('puts all-day entries first and the rest in time order', () => {
    const grouped = groupEntriesByDay(
      toCalendarEntries(
        [
          // Timed values are placed in the viewer's day, so they are written
          // here as local times: the assertion then holds in any zone.
          row('Mittag', new Date(2026, 8, 18, 12).toISOString()),
          row('Geburtstag', { start: '2026-09-18T00:00:00.000Z', end: null, allDay: true }),
          row('Morgen', new Date(2026, 8, 18, 8).toISOString()),
        ],
        'when',
      ),
    );

    expect(grouped.get('2026-09-18')?.map((entry) => entry.row.document.title)).toEqual([
      'Geburtstag',
      'Morgen',
      'Mittag',
    ]);
  });
});
