import type { SettingKey } from '@exocortex/contracts';

/**
 * The settings that store a share between 0 and 1 and are edited as a
 * percentage (issue #170). Listed by key rather than read off a suffix: there
 * is one of them, and `*Percent` settings already store whole percentages.
 */
const FRACTION_SETTING_KEYS: ReadonlySet<string> = new Set<SettingKey>([
  'memory.factConfidenceFloor',
]);

export function isFractionSettingKey(key: string): boolean {
  return FRACTION_SETTING_KEYS.has(key);
}

/**
 * A stored share as the percentage the field shows, to two decimals. The
 * rounding hides the binary noise of `0.15 * 100`, never a digit anybody typed.
 */
export function percentOfFraction(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/**
 * The share a typed percentage stands for, or `null` for text that is no
 * number between 0 and 100. A number field hands over `.` as its decimal
 * separator whatever the reader's locale, so only that one is read.
 */
export function fractionOfPercent(text: string): number | null {
  if (text.trim().length === 0) return null;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100) / 10_000;
}
