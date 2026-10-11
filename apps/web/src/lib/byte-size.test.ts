import { describe, expect, it } from 'vitest';

import {
  amountInUnit,
  BYTE_UNITS,
  bytesFromAmount,
  describeBytes,
  isByteSettingKey,
  preferredByteUnit,
} from './byte-size';

describe('preferredByteUnit', () => {
  it.each([
    [500_000_000, 'MB', '500'],
    [10 * 1_024 * 1_024, 'MiB', '10'],
    [25 * 1_024 * 1_024, 'MiB', '25'],
    [100_000, 'KB', '100'],
    [1_024, 'KiB', '1'],
    [1_500_000_000, 'GB', '1.5'],
    [2 * 1_024 ** 3, 'GiB', '2'],
    [1_000, 'KB', '1'],
    [999, 'B', '999'],
    [1_234_567, 'KB', '1234.567'],
    [1_234_567_891, 'KB', '1234567.891'],
  ] as const)('shows %d as %s %s', (bytes, unit, amount) => {
    expect(preferredByteUnit(bytes)).toBe(unit);
    expect(amountInUnit(bytes, unit)).toBe(amount);
  });

  it('falls back to bytes for zero, negatives and non-integers', () => {
    expect(preferredByteUnit(0)).toBe('B');
    expect(preferredByteUnit(-1_000)).toBe('B');
    expect(preferredByteUnit(1.5)).toBe('B');
  });
});

describe('bytesFromAmount', () => {
  it('multiplies decimal amounts out exactly', () => {
    expect(bytesFromAmount('500', 'MB')).toBe(500_000_000);
    expect(bytesFromAmount('0.1', 'MB')).toBe(100_000);
    expect(bytesFromAmount('1.5', 'KiB')).toBe(1_536);
    expect(bytesFromAmount('10', 'MiB')).toBe(10_485_760);
    expect(bytesFromAmount(' 7 ', 'B')).toBe(7);
  });

  it('refuses amounts that fall between two bytes', () => {
    expect(bytesFromAmount('1.0001', 'KB')).toBeNull();
    expect(bytesFromAmount('0.5', 'B')).toBeNull();
    expect(bytesFromAmount('0.001', 'KiB')).toBeNull();
  });

  it('refuses text that is not a plain non-negative amount', () => {
    for (const text of ['', '-1', '1e6', 'abc', '1,5', '1.']) {
      expect(bytesFromAmount(text, 'MB')).toBeNull();
    }
  });

  it('refuses amounts beyond the safe integer range', () => {
    expect(bytesFromAmount('99999999999', 'GiB')).toBeNull();
  });

  it('round-trips every displayed value to the same byte count', () => {
    const samples = [
      1, 999, 1_000, 1_024, 100_000, 1_234_567, 10_485_760, 26_214_400, 52_428_800, 104_857_600,
      500_000_000, 1_500_000_000, 1_234_567_891,
    ];
    for (const bytes of samples) {
      const unit = preferredByteUnit(bytes);
      expect(bytesFromAmount(amountInUnit(bytes, unit), unit)).toBe(bytes);
    }
  });

  it('accepts every unit', () => {
    for (const unit of BYTE_UNITS) expect(bytesFromAmount('1', unit)).toBeGreaterThan(0);
  });
});

describe('describeBytes', () => {
  it('names the amount in the preferred unit', () => {
    expect(describeBytes(50 * 1_024 * 1_024)).toEqual({ amount: 50, unit: 'MiB' });
    expect(describeBytes(500_000_000)).toEqual({ amount: 500, unit: 'MB' });
  });
});

describe('isByteSettingKey', () => {
  it('follows the naming convention', () => {
    expect(isByteSettingKey('ai.pdfMaxBytes')).toBe(true);
    expect(isByteSettingKey('render.maxArtifactBytes')).toBe(true);
    expect(isByteSettingKey('projects.maxFileChars')).toBe(false);
  });
});
