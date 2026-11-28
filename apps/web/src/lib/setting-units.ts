/**
 * The unit a plain numeric setting is counted in, read off its key (issue
 * #203).
 *
 * Bytes, durations, money and shares are converted between the stored unit and
 * one a person reads (`byte-size.ts`, `duration.ts`, `money.ts`,
 * `fraction.ts`). These four are not: the stored number is already the one a
 * person thinks in, so the field keeps it and only says what it counts. Read
 * off the suffix like the others, so a setting added later as `*Chars` or
 * `*Days` gets its unit without an entry anywhere.
 */
export const COUNT_UNITS = ['percent', 'chars', 'tokens', 'days'] as const;

export type CountUnit = (typeof COUNT_UNITS)[number];

const SUFFIXES: readonly (readonly [string, CountUnit])[] = [
  ['Percent', 'percent'],
  ['Chars', 'chars'],
  ['Tokens', 'tokens'],
  ['Days', 'days'],
];

/** The unit a setting key counts in, or `null` for a plain count or a converted value. */
export function countUnitOfSettingKey(key: string): CountUnit | null {
  const name = key.slice(key.indexOf('.') + 1);
  for (const [suffix, unit] of SUFFIXES) {
    if (name.endsWith(suffix)) return unit;
  }
  return null;
}
