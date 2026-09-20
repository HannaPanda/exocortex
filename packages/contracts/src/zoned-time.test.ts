import { describe, expect, it } from 'vitest';

import { instantAtLocalTime, lastLocalHourSlot, localTimeParts } from './zoned-time';

/**
 * The zone arithmetic three features share (issue #106).
 *
 * What is worth testing is the two days a year nobody tests: the local day
 * that is 23 hours long and the one that is 25. Every other day agrees with
 * the naive reading, which is exactly why a bug here survives until March.
 */

describe('localTimeParts', () => {
  it('reads a wall clock in the zone rather than in the process', () => {
    const winter = localTimeParts(new Date('2026-01-15T12:00:00.000Z'), 'Europe/Berlin');
    expect(winter).toMatchObject({ year: 2026, month: 1, day: 15, hour: 13 });

    const summer = localTimeParts(new Date('2026-07-15T12:00:00.000Z'), 'Europe/Berlin');
    expect(summer.hour).toBe(14);
  });

  it('renders midnight as hour zero and not as the next day', () => {
    const parts = localTimeParts(new Date('2026-01-15T23:00:00.000Z'), 'Europe/Berlin');
    expect(parts).toMatchObject({ day: 16, hour: 0 });
  });
});

describe('instantAtLocalTime', () => {
  it('finds the instant a clock in the zone shows this time', () => {
    const instant = instantAtLocalTime(
      { year: 2026, month: 7, day: 15, hour: 7, minute: 0 },
      'Europe/Berlin',
    );
    expect(instant.toISOString()).toBe('2026-07-15T05:00:00.000Z');
  });

  it('pushes a local time the zone skips forward rather than dropping it', () => {
    // 02:30 does not exist on the morning the clocks go forward.
    const instant = instantAtLocalTime(
      { year: 2026, month: 3, day: 29, hour: 2, minute: 30 },
      'Europe/Berlin',
    );
    expect(instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('lastLocalHourSlot', () => {
  it('answers today once the hour has passed', () => {
    const now = new Date('2026-07-15T09:00:00.000Z'); // 11:00 in Berlin
    expect(lastLocalHourSlot(now, 7, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-15T05:00:00.000Z',
    );
  });

  it('answers yesterday while the hour is still ahead', () => {
    const now = new Date('2026-07-15T03:00:00.000Z'); // 05:00 in Berlin
    expect(lastLocalHourSlot(now, 7, 'Europe/Berlin').toISOString()).toBe(
      '2026-07-14T05:00:00.000Z',
    );
  });

  it('never answers with a moment that has not happened', () => {
    // Every hour of both transition days, in a zone that has them.
    for (const day of ['2026-03-29', '2026-10-25']) {
      for (let hour = 0; hour < 24; hour += 1) {
        const now = new Date(`${day}T${String(hour).padStart(2, '0')}:30:00.000Z`);
        for (let digest = 0; digest < 24; digest += 1) {
          expect(lastLocalHourSlot(now, digest, 'Europe/Berlin').getTime()).toBeLessThanOrEqual(
            now.getTime(),
          );
        }
      }
    }
  });

  it('stays within a day and a bit of now, so no slot is ever skipped', () => {
    const now = new Date('2026-10-25T12:00:00.000Z');
    for (let digest = 0; digest < 24; digest += 1) {
      const slot = lastLocalHourSlot(now, digest, 'Europe/Berlin');
      expect(now.getTime() - slot.getTime()).toBeLessThan(26 * 60 * 60 * 1000);
    }
  });
});
