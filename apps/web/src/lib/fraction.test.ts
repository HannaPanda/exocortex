import { describe, expect, it } from 'vitest';

import { fractionOfPercent, isFractionSettingKey, percentOfFraction } from './fraction';

describe('percentOfFraction', () => {
  it.each([
    [0.15, 15],
    [0, 0],
    [1, 100],
    [0.125, 12.5],
    [0.07, 7],
  ])('shows %s as %s percent', (fraction, percent) => {
    expect(percentOfFraction(fraction)).toBe(percent);
  });
});

describe('fractionOfPercent', () => {
  it.each([
    ['15', 0.15],
    ['0', 0],
    ['100', 1],
    ['12.5', 0.125],
    ['7', 0.07],
  ])('stores %s percent as %s', (text, fraction) => {
    expect(fractionOfPercent(text)).toBe(fraction);
  });

  it.each(['', ' ', '-1', '100.5', 'abc'])('refuses %j', (text) => {
    expect(fractionOfPercent(text)).toBeNull();
  });

  it('round-trips every stored value the field can show', () => {
    for (const fraction of [0, 0.01, 0.15, 0.333, 0.5, 0.9999, 1]) {
      expect(fractionOfPercent(String(percentOfFraction(fraction)))).toBe(fraction);
    }
  });
});

describe('isFractionSettingKey', () => {
  it('knows the confidence floor and nothing stored as whole percent', () => {
    expect(isFractionSettingKey('memory.factConfidenceFloor')).toBe(true);
    expect(isFractionSettingKey('search.semanticWeightPercent')).toBe(false);
  });
});
