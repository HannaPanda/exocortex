/**
 * Money as a person writes and reads it (issue #167).
 *
 * The database, the contracts, the API and the worker count millionths of a
 * US dollar as integers (`budgetMicroUsdPerRun: 2000000`), and they keep doing
 * so. Only what a person sees and types is dollars: `2,00 $`, never `2000000`.
 *
 * Conversion is exact in both directions. A micro-dollar has six decimals, so
 * every stored value has an exact dollar text, and a dollar amount typed in is
 * multiplied out with integers rather than floats: `0,05` is exactly `50000`.
 * An amount finer than a micro-dollar is refused rather than rounded, because
 * a rounded value would be saved as something the field never showed.
 */

export const MICRO_USD_PER_USD = 1_000_000;

const MICRO_DIGITS = 6;

/**
 * The largest budget a profile, a work item or an eval case accepts: 1000
 * dollars, the `budgetSchema` bound each of their contracts repeats.
 */
export const BUDGET_MAX_MICRO_USD = 1_000_000_000;

/** The part of a formatter this file needs; `useFormatter()` and `createFormatter()` both fit. */
export interface NumberFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string;
}

/**
 * The digits of a typed amount, or `null` when the text is not one.
 *
 * Both a comma and a point are read as the decimal separator, since `2,00` and
 * `2.00` are both how somebody writes two dollars. A separator is only read as
 * grouping when the text says so unambiguously: when both kinds appear (the
 * last one is the decimal), or when one kind appears more than once
 * (`1.000.000`). Grouping has to come in threes; `1.00.0` is refused rather
 * than guessed at. Spaces, apostrophes and a leading or trailing `$` are
 * ignored.
 */
type Separator = '.' | ',';

/**
 * Which separator is the decimal one and which groups thousands, or `null`
 * when the text uses them in a way that has no single reading.
 */
function separatorsOf(
  compact: string,
): { decimal: Separator | null; grouping: Separator | null } | null {
  const points = compact.split('.').length - 1;
  const commas = compact.split(',').length - 1;
  if (points > 0 && commas > 0) {
    const decimal: Separator = compact.lastIndexOf('.') > compact.lastIndexOf(',') ? '.' : ',';
    if ((decimal === '.' ? points : commas) !== 1) return null;
    return { decimal, grouping: decimal === '.' ? ',' : '.' };
  }
  if (points + commas === 1) return { decimal: points === 1 ? '.' : ',', grouping: null };
  if (points + commas > 1) return { decimal: null, grouping: points > 0 ? '.' : ',' };
  return { decimal: null, grouping: null };
}

function splitAmount(text: string): { whole: string; fraction: string } | null {
  const compact = text
    .trim()
    .replace(/^\$|\$$/g, '')
    .replace(/[\s\u00a0\u202f']/g, '');
  if (!/^[\d.,]+$/.test(compact) || !/\d/.test(compact)) return null;
  const separators = separatorsOf(compact);
  if (separators === null) return null;
  const { decimal, grouping } = separators;
  const [wholeText = '', fraction = ''] = decimal === null ? [compact] : compact.split(decimal);
  if (!/^\d*$/.test(fraction)) return null;
  if (grouping !== null && !/^\d{1,3}(?:[.,]\d{3})+$/.test(wholeText)) return null;
  const whole = grouping === null ? wholeText : wholeText.split(grouping).join('');
  if (!/^\d*$/.test(whole) || whole.length + fraction.length === 0) return null;
  return { whole: whole.length === 0 ? '0' : whole, fraction };
}

/**
 * The micro-dollars a typed dollar amount names, or `null` when it is not one:
 * empty, negative, not a number, finer than a micro-dollar, or too large to be
 * a safe integer. `0` is a value and comes back as `0`, never as empty.
 */
export function microUsdFromText(text: string): number | null {
  const parts = splitAmount(text);
  if (parts === null) return null;
  const fraction = parts.fraction.replace(/0+$/, '');
  if (fraction.length > MICRO_DIGITS) return null;
  const micro = BigInt(parts.whole + fraction.padEnd(MICRO_DIGITS, '0'));
  return micro > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(micro);
}

/** The character the reader's language writes between dollars and cents. */
export function decimalSeparatorOf(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')
      ?.value ?? '.'
  );
}

/**
 * A stored amount as the text an input field shows: exact, with at least two
 * decimals and the reader's decimal separator, without grouping and without a
 * currency sign (`2000000` is `2,00` in German, `1234` is `0.001234` in
 * English). `microUsdFromText` reads every such text back to the same value.
 */
export function usdInputText(microUsd: number, locale: string): string {
  const negative = microUsd < 0;
  const digits = String(Math.abs(Math.trunc(microUsd))).padStart(MICRO_DIGITS + 1, '0');
  const whole = digits.slice(0, -MICRO_DIGITS);
  const fraction = digits.slice(-MICRO_DIGITS).replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}${decimalSeparatorOf(locale)}${fraction}`;
}

/**
 * How much detail an amount is shown in:
 *
 * - `cost`: what a run, a day or a budget amounts to. Two to four decimals,
 *   because most runs cost cents; an amount below a hundredth of a cent gets
 *   up to six, so a positive cost never reads as `0,00 $`.
 * - `price`: a model's price per million tokens. Exact (up to six decimals),
 *   because `0,075 $` rounded to `0,08 $` is a different price.
 */
export type MoneyPrecision = 'cost' | 'price';

/** Below this many micro-dollars, four decimals would round a cost to zero. */
const SMALL_COST_MICRO_USD = 100;

/** A stored amount as dollars in the reader's language (`2,00 $`, `$0.00003`). */
export function formatMicroUsd(
  format: NumberFormatter,
  microUsd: number,
  precision: MoneyPrecision = 'cost',
): string {
  const tiny = microUsd !== 0 && Math.abs(microUsd) < SMALL_COST_MICRO_USD;
  return format.number(microUsd / MICRO_USD_PER_USD, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: precision === 'price' || tiny ? MICRO_DIGITS : 4,
  });
}

/**
 * Whether a setting holds an amount of money. A naming convention, like
 * `*Bytes`, so a budget setting added later gets the dollar field by itself.
 */
export function isMoneySettingKey(key: string): boolean {
  return key.includes('MicroUsd');
}

/**
 * The micro-dollars a `MoneyTextInput` draft holds (`components/money-input.tsx`):
 * `null` for an empty field, `undefined` for one that is refusing what was
 * typed, so a caller can tell "no limit" from "not yet savable".
 */
export function microUsdOfDraft(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}
