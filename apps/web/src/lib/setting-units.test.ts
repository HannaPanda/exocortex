import { describe, expect, it } from 'vitest';

import { SETTING_KEYS, SETTING_NUMBER_RANGES } from '@exocortex/contracts';

import { isByteSettingKey } from './byte-size';
import { durationBaseOfSettingKey } from './duration';
import { isFractionSettingKey } from './fraction';
import { isMoneySettingKey } from './money';
import { countUnitOfSettingKey } from './setting-units';

describe('countUnitOfSettingKey', () => {
  it.each([
    ['ai.compactionThresholdPercent', 'percent'],
    ['search.semanticWeightPercent', 'percent'],
    ['agents.oversizedPageChars', 'chars'],
    ['projects.maxFileChars', 'chars'],
    ['ai.maxOutputTokens', 'tokens'],
    ['memory.retentionDays', 'days'],
    ['memory.messageExpiryDays', 'days'],
  ])('reads %s as %s', (key, unit) => {
    expect(countUnitOfSettingKey(key)).toBe(unit);
  });

  it.each([
    'memory.recallMaxResults',
    'ai.pdfMaxBytes',
    'ai.timeoutMs',
    'ai.budgetMicroUsdPerRun',
    'memory.factConfidenceFloor',
    'notifications.digestHour',
  ])('gives %s no counted unit', (key) => {
    expect(countUnitOfSettingKey(key)).toBeNull();
  });

  // A unit beside a field is only right for a number that is shown as it is
  // stored; a converted value already carries its own unit.
  it('names only settings that are bounded numbers shown as stored', () => {
    for (const key of SETTING_KEYS) {
      if (countUnitOfSettingKey(key) === null) continue;
      expect(SETTING_NUMBER_RANGES[key], key).toBeDefined();
      expect(isByteSettingKey(key), key).toBe(false);
      expect(isMoneySettingKey(key), key).toBe(false);
      expect(isFractionSettingKey(key), key).toBe(false);
      expect(durationBaseOfSettingKey(key), key).toBeNull();
    }
  });
});
