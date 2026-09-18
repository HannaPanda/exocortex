import { describe, expect, it } from 'vitest';

import {
  addDays,
  calendarLabel,
  calendarWindow,
  fromDateInputValue,
  monthGridStart,
  queryWindow,
  startOfWeek,
  stepAnchor,
  toDateInputValue,
} from './range';

/** Local calendar parts, so an assertion says nothing about the runner's zone. */
function parts(date: Date): [number, number, number, number, number] {
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()];
}

describe('startOfWeek', () => {
  it('returns the Monday of the week, and a Monday itself', () => {
    // 2026-09-18 is a Friday.
    expect(parts(startOfWeek(new Date(2026, 8, 18, 13, 30)))).toEqual([2026, 8, 14, 0, 0]);
    expect(parts(startOfWeek(new Date(2026, 8, 14)))).toEqual([2026, 8, 14, 0, 0]);
  });

  it('reaches back into the previous month on a Sunday', () => {
    // 2026-11-01 is a Sunday: its week began in October.
    expect(parts(startOfWeek(new Date(2026, 10, 1)))).toEqual([2026, 9, 26, 0, 0]);
  });
});

describe('calendarWindow', () => {
  const anchor = new Date(2026, 8, 18, 16, 45);

  it('covers exactly one local day in DAY mode', () => {
    const window = calendarWindow('DAY', anchor);
    expect(parts(window.from)).toEqual([2026, 8, 18, 0, 0]);
    expect(parts(window.to)).toEqual([2026, 8, 19, 0, 0]);
  });

  it('covers Monday to Monday in WEEK mode', () => {
    const window = calendarWindow('WEEK', anchor);
    expect(parts(window.from)).toEqual([2026, 8, 14, 0, 0]);
    expect(parts(window.to)).toEqual([2026, 8, 21, 0, 0]);
  });

  it('covers the whole six-week grid in MONTH mode, not just the month', () => {
    const window = calendarWindow('MONTH', anchor);
    // September 2026 starts on a Tuesday, so the grid opens on 31 August.
    expect(parts(window.from)).toEqual([2026, 7, 31, 0, 0]);
    expect(parts(window.to)).toEqual([2026, 9, 12, 0, 0]);
  });

  it('covers the month itself in LIST mode', () => {
    const window = calendarWindow('LIST', anchor);
    expect(parts(window.from)).toEqual([2026, 8, 1, 0, 0]);
    expect(parts(window.to)).toEqual([2026, 9, 1, 0, 0]);
  });

  it('covers the calendar year in YEAR mode', () => {
    const window = calendarWindow('YEAR', anchor);
    expect(parts(window.from)).toEqual([2026, 0, 1, 0, 0]);
    expect(parts(window.to)).toEqual([2027, 0, 1, 0, 0]);
  });
});

describe('monthGridStart', () => {
  it('starts on the first of the month when that is a Monday', () => {
    // 2026-06-01 is a Monday.
    expect(parts(monthGridStart(2026, 5))).toEqual([2026, 5, 1, 0, 0]);
  });
});

describe('stepAnchor', () => {
  it('steps by one day, week and year', () => {
    expect(parts(stepAnchor('DAY', new Date(2026, 8, 18), 1))).toEqual([2026, 8, 19, 0, 0]);
    expect(parts(stepAnchor('WEEK', new Date(2026, 8, 18), -1))).toEqual([2026, 8, 11, 0, 0]);
    expect(parts(stepAnchor('YEAR', new Date(2026, 8, 18), 1))).toEqual([2027, 8, 1, 0, 0]);
  });

  it('lands on the first of the month, so a 31st cannot skip a month', () => {
    expect(parts(stepAnchor('MONTH', new Date(2026, 2, 31), 1))).toEqual([2026, 3, 1, 0, 0]);
    expect(parts(stepAnchor('LIST', new Date(2026, 0, 31), -1))).toEqual([2025, 11, 1, 0, 0]);
  });
});

describe('calendarLabel', () => {
  it('names the day, the month and the year', () => {
    expect(calendarLabel('DAY', new Date(2026, 8, 18))).toBe('Freitag, 18. September 2026');
    expect(calendarLabel('MONTH', new Date(2026, 8, 18))).toBe('September 2026');
    expect(calendarLabel('LIST', new Date(2026, 8, 18))).toBe('September 2026');
    expect(calendarLabel('YEAR', new Date(2026, 8, 18))).toBe('2026');
  });

  it('names a week once when it stays in one month, twice when it does not', () => {
    expect(calendarLabel('WEEK', new Date(2026, 8, 18))).toBe('14. bis 20. September 2026');
    expect(calendarLabel('WEEK', new Date(2026, 8, 30))).toBe('28. September bis 4. Oktober 2026');
    expect(calendarLabel('WEEK', new Date(2026, 11, 31))).toBe(
      '28. Dezember 2026 bis 3. Januar 2027',
    );
  });
});

describe('queryWindow', () => {
  it('pads a day on each side, so an all-day value stored at UTC midnight cannot fall out', () => {
    const window = calendarWindow('DAY', new Date(2026, 8, 18));
    const padded = queryWindow(window);
    expect(new Date(padded.from).getTime()).toBe(addDays(window.from, -1).getTime());
    expect(new Date(padded.to).getTime()).toBe(addDays(window.to, 1).getTime());
  });
});

describe('the date input value', () => {
  it('round-trips a local date', () => {
    const value = toDateInputValue(new Date(2026, 0, 5));
    expect(value).toBe('2026-01-05');
    expect(parts(fromDateInputValue(value) as Date)).toEqual([2026, 0, 5, 0, 0]);
  });

  it('rejects what the picker produces when it is cleared', () => {
    expect(fromDateInputValue('')).toBeNull();
  });
});
