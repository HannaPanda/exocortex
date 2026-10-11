import { describe, expect, it } from 'vitest';

import {
  amountInDurationUnit,
  describeDuration,
  durationBaseOfSettingKey,
  durationFromAmount,
  durationUnitsFor,
  isHourOfDaySettingKey,
  preferredDurationUnit,
  withStoredUnit,
} from './duration';

describe('durationUnitsFor', () => {
  it('offers the stored unit and every larger one that fits under the maximum', () => {
    expect(durationUnitsFor('seconds', 30 * 86_400)).toEqual([
      'seconds',
      'minutes',
      'hours',
      'days',
    ]);
    expect(durationUnitsFor('seconds', 60)).toEqual(['seconds', 'minutes']);
    expect(durationUnitsFor('minutes', 60)).toEqual(['minutes', 'hours']);
    expect(durationUnitsFor('minutes', 1_440)).toEqual(['minutes', 'hours', 'days']);
    expect(durationUnitsFor('seconds')).toEqual(['seconds', 'minutes', 'hours', 'days']);
  });

  it('leaves milliseconds out even for a value stored in them', () => {
    expect(durationUnitsFor('milliseconds', 600_000)).toEqual(['seconds', 'minutes']);
    expect(durationUnitsFor('milliseconds', 3_600_000)).toEqual(['seconds', 'minutes', 'hours']);
  });
});

describe('preferredDurationUnit', () => {
  const seconds = durationUnitsFor('seconds', 30 * 86_400);
  const ms = durationUnitsFor('milliseconds', 3_600_000);

  it.each([
    [604_800, 'seconds', seconds, 'days', '7'],
    [2_592_000, 'seconds', seconds, 'days', '30'],
    [60, 'seconds', seconds, 'minutes', '1'],
    [300, 'seconds', seconds, 'minutes', '5'],
    [90, 'seconds', seconds, 'seconds', '90'],
    [7_200, 'seconds', seconds, 'hours', '2'],
    [180_000, 'milliseconds', ms, 'minutes', '3'],
    [900_000, 'milliseconds', ms, 'minutes', '15'],
    [5_000, 'milliseconds', ms, 'seconds', '5'],
    [3_600_000, 'milliseconds', ms, 'hours', '1'],
  ] as const)('shows %d %s as %s %s', (value, base, units, unit, amount) => {
    expect(preferredDurationUnit(value, base, units)).toBe(unit);
    expect(amountInDurationUnit(value, base, unit)).toBe(amount);
  });

  it('shows zero in the smallest offered unit', () => {
    expect(preferredDurationUnit(0, 'minutes', ['minutes', 'hours', 'days'])).toBe('minutes');
  });

  it('falls back to the stored unit when no offered unit divides the value', () => {
    expect(preferredDurationUnit(5_500, 'milliseconds', ms)).toBe('milliseconds');
    expect(withStoredUnit(5_500, 'milliseconds', ms)).toEqual(['milliseconds', ...ms]);
    expect(withStoredUnit(5_000, 'milliseconds', ms)).toEqual(ms);
  });
});

describe('durationFromAmount', () => {
  it('multiplies an amount out into the stored unit', () => {
    expect(durationFromAmount('7', 'days', 'seconds')).toBe(604_800);
    expect(durationFromAmount('3', 'minutes', 'milliseconds')).toBe(180_000);
    expect(durationFromAmount('2', 'hours', 'minutes')).toBe(120);
  });

  it('accepts a decimal point and a decimal comma alike', () => {
    expect(durationFromAmount('1.5', 'hours', 'seconds')).toBe(5_400);
    expect(durationFromAmount('1,5', 'hours', 'seconds')).toBe(5_400);
    expect(durationFromAmount(' 0,1 ', 'minutes', 'seconds')).toBe(6);
  });

  it('refuses an amount between two whole stored units instead of rounding it', () => {
    expect(durationFromAmount('1.5', 'seconds', 'seconds')).toBeNull();
    expect(durationFromAmount('0.01', 'minutes', 'seconds')).toBeNull();
    expect(durationFromAmount('0.0005', 'seconds', 'milliseconds')).toBeNull();
  });

  it('refuses what is not a plain non-negative amount', () => {
    for (const text of ['', ' ', '-1', '1e3', 'abc', '1.000,5', '1,000.5', '1.', '.5', '7 Tage']) {
      expect(durationFromAmount(text, 'days', 'seconds')).toBeNull();
    }
  });

  it('refuses a unit smaller than the stored one', () => {
    expect(durationFromAmount('1000', 'milliseconds', 'seconds')).toBeNull();
  });

  it('keeps zero as zero', () => {
    expect(durationFromAmount('0', 'minutes', 'minutes')).toBe(0);
    expect(durationFromAmount('0', 'hours', 'minutes')).toBe(0);
  });

  it('refuses a count past the safe integer range', () => {
    expect(durationFromAmount('9'.repeat(20), 'days', 'milliseconds')).toBeNull();
  });

  it('round-trips every displayed value exactly', () => {
    const units = durationUnitsFor('seconds', 30 * 86_400);
    for (const value of [60, 61, 90, 300, 3_599, 3_600, 86_399, 604_800, 2_592_000]) {
      const unit = preferredDurationUnit(value, 'seconds', units);
      expect(
        durationFromAmount(amountInDurationUnit(value, 'seconds', unit), unit, 'seconds'),
      ).toBe(value);
    }
  });
});

describe('describeDuration', () => {
  it('names a bound in the unit it reads best in', () => {
    expect(describeDuration(60, 'seconds')).toEqual({ amount: 1, unit: 'minutes' });
    expect(describeDuration(2_592_000, 'seconds')).toEqual({ amount: 30, unit: 'days' });
    expect(describeDuration(5_000, 'milliseconds')).toEqual({ amount: 5, unit: 'seconds' });
    expect(describeDuration(600_000, 'milliseconds')).toEqual({ amount: 10, unit: 'minutes' });
    expect(describeDuration(1_440, 'minutes')).toEqual({ amount: 1, unit: 'days' });
    expect(describeDuration(0, 'minutes')).toEqual({ amount: 0, unit: 'minutes' });
  });
});

describe('setting key conventions', () => {
  it('reads the stored unit off the key', () => {
    expect(durationBaseOfSettingKey('ai.timeoutMs')).toBe('milliseconds');
    expect(durationBaseOfSettingKey('workflows.maxLifetimeSeconds')).toBe('seconds');
    expect(durationBaseOfSettingKey('calendar.reminderLeadMinutes')).toBe('minutes');
    expect(durationBaseOfSettingKey('memory.retentionDays')).toBeNull();
    expect(durationBaseOfSettingKey('ai.maxOutputTokens')).toBeNull();
  });

  it('recognises an hour of the day', () => {
    expect(isHourOfDaySettingKey('notifications.digestHour')).toBe(true);
    expect(isHourOfDaySettingKey('calendar.reminderAllDayHour')).toBe(true);
    expect(isHourOfDaySettingKey('workflows.maxLifetimeSeconds')).toBe(false);
  });
});
