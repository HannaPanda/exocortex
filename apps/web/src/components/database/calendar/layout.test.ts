import { describe, expect, it } from 'vitest';

import { type DatabaseRow } from '@exocortex/contracts';

import { type CalendarEntry } from './entries';
import { layoutDay, MINUTES_PER_DAY, type PositionedEntry } from './layout';

/** Local times in, ISO instants out: that is the shape the API returns. */
function entry(title: string, start: Date, end: Date | null, allDay = false): CalendarEntry {
  return {
    row: { document: { id: title, title }, values: [] } as unknown as DatabaseRow,
    start: start.toISOString(),
    end: end === null ? null : end.toISOString(),
    allDay,
  };
}

const day = new Date(2026, 8, 18);
const at = (hour: number, minute = 0) => new Date(2026, 8, 18, hour, minute);

function titles(result: readonly PositionedEntry[]): string[] {
  return result.map((item) => item.entry.row.document.title);
}

/** The single placement a case expects, or a failure that says what came back instead. */
function only(result: readonly PositionedEntry[]): PositionedEntry {
  const [first, ...rest] = result;
  if (first === undefined || rest.length > 0) {
    throw new Error(`Erwartet: genau eine Platzierung, bekommen: ${result.length}`);
  }
  return first;
}

describe('layoutDay', () => {
  it('places an appointment on its wall-clock minutes', () => {
    const placed = only(layoutDay([entry('Zahnarzt', at(9), at(10, 30))], day, 'de'));
    expect(placed.startMinute).toBe(9 * 60);
    expect(placed.endMinute).toBe(10 * 60 + 30);
    expect(placed.columns).toBe(1);
    expect(placed.continuesBefore).toBe(false);
    expect(placed.continuesAfter).toBe(false);
  });

  it('gives an appointment without an end a default length', () => {
    const placed = only(layoutDay([entry('Offen', at(9), null)], day, 'de'));
    expect(placed.endMinute).toBe(10 * 60);
  });

  it('draws a very short appointment tall enough to read', () => {
    const placed = only(layoutDay([entry('Kurz', at(9), at(9, 5))], day, 'de'));
    expect(placed.endMinute).toBe(9 * 60 + 30);
  });

  it('skips all-day entries, which belong in the band above the axis', () => {
    expect(layoutDay([entry('Geburtstag', at(0), at(0), true)], day, 'de')).toEqual([]);
  });

  it('skips an appointment of a neighbouring day', () => {
    expect(
      layoutDay([entry('Gestern', new Date(2026, 8, 17, 9), new Date(2026, 8, 17, 10))], day, 'de'),
    ).toEqual([]);
  });

  it('clamps a span that started yesterday and marks both edges', () => {
    const placed = only(
      layoutDay(
        [entry('Konferenz', new Date(2026, 8, 17, 9), new Date(2026, 8, 19, 17))],
        day,
        'de',
      ),
    );
    expect(placed.startMinute).toBe(0);
    expect(placed.endMinute).toBe(MINUTES_PER_DAY);
    expect(placed.continuesBefore).toBe(true);
    expect(placed.continuesAfter).toBe(true);
  });

  it('ends an appointment at the bottom of the day, not at the top of it', () => {
    const placed = only(
      layoutDay([entry('Nachtschicht', at(22), new Date(2026, 8, 19))], day, 'de'),
    );
    expect(placed.endMinute).toBe(MINUTES_PER_DAY);
    expect(placed.continuesAfter).toBe(false);
  });

  it('puts two overlapping appointments side by side', () => {
    const result = layoutDay(
      [entry('B', at(9, 30), at(10, 30)), entry('A', at(9), at(10))],
      day,
      'de',
    );
    expect(titles(result)).toEqual(['A', 'B']);
    expect(result.map((item) => item.column)).toEqual([0, 1]);
    expect(result.map((item) => item.columns)).toEqual([2, 2]);
  });

  it('reuses a column once it is free again', () => {
    const result = layoutDay(
      [
        entry('Lang', at(9), at(12)),
        entry('Früh', at(9, 30), at(10)),
        entry('Spät', at(10, 30), at(11)),
      ],
      day,
      'de',
    );
    // "Spät" starts after "Früh" ends, so it takes the same second column
    // rather than opening a third one and making everything a third as wide.
    expect(
      result.map((item) => [item.entry.row.document.title, item.column, item.columns]),
    ).toEqual([
      ['Lang', 0, 2],
      ['Früh', 1, 2],
      ['Spät', 1, 2],
    ]);
  });

  it('keeps a later, separate appointment at full width', () => {
    const result = layoutDay(
      [
        entry('A', at(9), at(10)),
        entry('B', at(9, 30), at(10)),
        entry('Nachmittag', at(15), at(16)),
      ],
      day,
      'de',
    );
    const afternoon = result.find((item) => item.entry.row.document.title === 'Nachmittag');
    expect(afternoon?.columns).toBe(1);
    expect(afternoon?.column).toBe(0);
  });

  it('gives the longer of two appointments starting together the left column', () => {
    const result = layoutDay(
      [entry('Kurz', at(9), at(9, 45)), entry('Lang', at(9), at(12))],
      day,
      'de',
    );
    expect(titles(result)).toEqual(['Lang', 'Kurz']);
  });

  it('ignores a value that is not a date', () => {
    const broken = { ...entry('Kaputt', at(9), null), start: 'irgendwann' };
    expect(layoutDay([broken], day, 'de')).toEqual([]);
  });
});
