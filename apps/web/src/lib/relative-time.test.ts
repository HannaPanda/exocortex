import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelativeTime } from './relative-time';

const NOW = new Date('2026-09-16T12:00:00.000Z');

/** `now` minus the given minutes, as the ISO string the API sends. */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatRelativeTime', () => {
  it('counts minutes below the hour', () => {
    expect(formatRelativeTime(ago(0))).toBe('in dieser Minute');
    expect(formatRelativeTime(ago(3))).toBe('vor 3 Minuten');
    expect(formatRelativeTime(ago(59))).toBe('vor 59 Minuten');
  });

  it('switches to hours, days and months at each boundary', () => {
    expect(formatRelativeTime(ago(60))).toBe('vor 1 Stunde');
    expect(formatRelativeTime(ago(60 * 24))).toBe('gestern');
    expect(formatRelativeTime(ago(60 * 24 * 5))).toBe('vor 5 Tagen');
    expect(formatRelativeTime(ago(60 * 24 * 40))).toBe('letzten Monat');
  });

  it('reads a future timestamp forwards', () => {
    // Clocks disagree: a server a few seconds ahead must not produce "vor -1".
    expect(formatRelativeTime(ago(-90))).toBe('in 2 Stunden');
  });
});
