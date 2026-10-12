import { createFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';

import {
  decimalSeparatorOf,
  formatMicroUsd,
  isMoneySettingKey,
  microUsdFromText,
  usdInputText,
} from './money';

/** Normalizes the narrow and non-breaking spaces `Intl` puts around a currency sign. */
function plain(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

describe('microUsdFromText', () => {
  it.each([
    ['2', 2_000_000],
    ['2,00', 2_000_000],
    ['2.00', 2_000_000],
    ['0,05', 50_000],
    ['0.05', 50_000],
    [',5', 500_000],
    ['5.', 5_000_000],
    ['0.000001', 1],
    ['0,1', 100_000],
    ['0.30', 300_000],
    ['1.234,56', 1_234_560_000],
    ['1,234.56', 1_234_560_000],
    ['1.000.000', 1_000_000_000_000],
    ['1 000,50', 1_000_500_000],
    ["1'000.50", 1_000_500_000],
    ['$2.50', 2_500_000],
    ['  3  ', 3_000_000],
    ['1.0000000', 1_000_000],
  ])('reads %j as %i micro-dollars', (text, micro) => {
    expect(microUsdFromText(text)).toBe(micro);
  });

  it('reads zero as a value, not as empty', () => {
    expect(microUsdFromText('0')).toBe(0);
    expect(microUsdFromText('0,00')).toBe(0);
  });

  it.each([
    [''],
    ['   '],
    ['-1'],
    ['abc'],
    ['1e6'],
    ['.'],
    ['1,2,3'],
    ['1.00.0'],
    ['1,234.5.6'],
    ['0.0000001'],
    ['1.2345678'],
    ['99999999999999'],
    ['Infinity'],
  ])('refuses %j', (text) => {
    expect(microUsdFromText(text)).toBeNull();
  });

  it('is exact where floats are not', () => {
    // 0.1 + 0.2 and 1.15 * 1e6 are the classic float artefacts.
    expect(microUsdFromText('0.3')).toBe(300_000);
    expect(microUsdFromText('1.15')).toBe(1_150_000);
    expect(microUsdFromText('4.35')).toBe(4_350_000);
  });
});

describe('usdInputText', () => {
  it.each([
    [2_000_000, 'de', '2,00'],
    [2_000_000, 'en', '2.00'],
    [50_000, 'de', '0,05'],
    [500_000, 'en', '0.50'],
    [1, 'en', '0.000001'],
    [1_234, 'de', '0,001234'],
    [0, 'de', '0,00'],
    [123_456_789, 'en', '123.456789'],
  ])('writes %i in %s as %j', (micro, locale, text) => {
    expect(usdInputText(micro, locale)).toBe(text);
  });

  it('reads back to the same value in every locale, which keeps an unchanged save exact', () => {
    for (const locale of ['de', 'en', 'fr', 'it', 'nl', 'pl', 'pt-BR', 'es']) {
      for (const micro of [0, 1, 999, 50_000, 1_000_000, 2_000_000, 12_345_678, 100_000_000]) {
        expect(microUsdFromText(usdInputText(micro, locale))).toBe(micro);
      }
    }
  });
});

describe('decimalSeparatorOf', () => {
  it('follows the language', () => {
    expect(decimalSeparatorOf('de')).toBe(',');
    expect(decimalSeparatorOf('en')).toBe('.');
  });
});

describe('formatMicroUsd', () => {
  const de = createFormatter({ locale: 'de' });
  const en = createFormatter({ locale: 'en' });

  it('shows a budget with two decimals in the reader’s language', () => {
    expect(plain(formatMicroUsd(de, 2_000_000))).toBe('2,00 $');
    expect(plain(formatMicroUsd(en, 2_000_000))).toBe('$2.00');
  });

  it('keeps up to four decimals for a cost', () => {
    expect(plain(formatMicroUsd(en, 12_345))).toBe('$0.0123');
    expect(plain(formatMicroUsd(en, 0))).toBe('$0.00');
  });

  it('never shows a positive cost as zero', () => {
    expect(plain(formatMicroUsd(en, 30))).toBe('$0.00003');
    expect(plain(formatMicroUsd(en, 1))).toBe('$0.000001');
    expect(plain(formatMicroUsd(de, 99))).toBe('0,000099 $');
  });

  it('shows a price exactly', () => {
    expect(plain(formatMicroUsd(en, 75_000, 'price'))).toBe('$0.075');
    expect(plain(formatMicroUsd(en, 3_000_000, 'price'))).toBe('$3.00');
    expect(plain(formatMicroUsd(en, 4_000, 'price'))).toBe('$0.004');
  });
});

describe('isMoneySettingKey', () => {
  it('recognises the micro-dollar settings by name', () => {
    expect(isMoneySettingKey('ai.budgetMicroUsdPerRun')).toBe(true);
    expect(isMoneySettingKey('workflows.budgetMicroUsdPerRun')).toBe(true);
    expect(isMoneySettingKey('ai.pdfMaxBytes')).toBe(false);
  });
});
