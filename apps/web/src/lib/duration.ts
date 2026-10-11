/**
 * Durations as a person writes them (issue #169).
 *
 * The API, the database and the worker keep whatever unit a value was defined
 * in (milliseconds, seconds, minutes); only the forms speak in units a person
 * reads. 604800 seconds is 7 days, and a field asking for the number of seconds
 * in a week asks somebody to do arithmetic the computer is better at.
 *
 * Conversion is exact in both directions, the same way as `byte-size.ts`. A
 * stored value is shown in the largest unit it fills a whole number of, and an
 * amount typed in is only accepted when it names a whole number of the stored
 * unit, so opening and saving a form never moves a limit. Weeks, months and
 * years are left out on purpose: a month is no fixed number of days.
 */

export const DURATION_UNITS = ['milliseconds', 'seconds', 'minutes', 'hours', 'days'] as const;

export type DurationUnit = (typeof DURATION_UNITS)[number];

/** Each unit in milliseconds. */
const UNIT_MS: Record<DurationUnit, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** How many `base` one `unit` is; only defined for a unit at least as large as `base`. */
function factorOf(unit: DurationUnit, base: DurationUnit): number {
  return UNIT_MS[unit] / UNIT_MS[base];
}

/**
 * The units a field offers: those at least as large as the stored unit, and no
 * larger than one that fits under the field's maximum. Milliseconds are left
 * out even for a value stored in them, because nobody thinks of a timeout in
 * milliseconds; `withStoredUnit` adds the stored unit back when a value
 * needs it to stay exact.
 */
export function durationUnitsFor(base: DurationUnit, max?: number): DurationUnit[] {
  return DURATION_UNITS.filter(
    (unit) =>
      UNIT_MS[unit] >= UNIT_MS[base] &&
      unit !== 'milliseconds' &&
      (max === undefined || factorOf(unit, base) <= max),
  );
}

/**
 * The offered units plus the stored one, when a value fills no whole number
 * of any offered unit (5500 milliseconds). Without it the field would have no
 * unit to show that value in.
 */
export function withStoredUnit(
  value: number,
  base: DurationUnit,
  units: readonly DurationUnit[],
): DurationUnit[] {
  const unit = preferredDurationUnit(value, base, units);
  return units.includes(unit) ? [...units] : [unit, ...units];
}

/**
 * The unit a stored count is shown in: the largest of `units` it fills a whole
 * number of. `604800` seconds is 7 days, `300` seconds 5 minutes, and a value
 * none of them divides falls back to the stored unit itself.
 */
export function preferredDurationUnit(
  value: number,
  base: DurationUnit,
  units: readonly DurationUnit[],
): DurationUnit {
  if (!Number.isSafeInteger(value) || value <= 0) return smallest(units, base);
  const largestFirst = [...units].sort((a, b) => UNIT_MS[b] - UNIT_MS[a]);
  for (const unit of largestFirst) {
    if (UNIT_MS[unit] < UNIT_MS[base]) continue;
    if (value % factorOf(unit, base) === 0) return unit;
  }
  return base;
}

/** The smallest offered unit, which is where a zero reads most naturally. */
function smallest(units: readonly DurationUnit[], base: DurationUnit): DurationUnit {
  const sorted = [...units].sort((a, b) => UNIT_MS[a] - UNIT_MS[b]);
  return sorted[0] ?? base;
}

/** The amount of `unit` a stored count is, as plain decimal text (`"1.5"`). */
export function amountInDurationUnit(
  value: number,
  base: DurationUnit,
  unit: DurationUnit,
): string {
  return String(value / factorOf(unit, base));
}

/**
 * The stored count an amount typed in names, or `null` when it is not one.
 *
 * Both a decimal point and a decimal comma are accepted (`1,5` and `1.5`
 * hours are 5400 seconds); grouping separators are not, because `1.000` would
 * then mean a thousand in one language and one in another. The decimal is
 * multiplied out with integers, and an amount that lands between two whole
 * units of the stored value is refused instead of rounded.
 */
export function durationFromAmount(
  amount: string,
  unit: DurationUnit,
  base: DurationUnit,
): number | null {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(amount.trim());
  if (match === null || UNIT_MS[unit] < UNIT_MS[base]) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const scale = BigInt(10) ** BigInt(fraction.length);
  const product = BigInt(whole + fraction) * BigInt(factorOf(unit, base));
  if (product % scale !== BigInt(0)) return null;
  const count = product / scale;
  return count > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(count);
}

/**
 * A stored count in the unit it reads best in, for running text: the bounds
 * of a field, `1 Minute bis 30 Tage`. Every unit is a candidate here, so a
 * bound of 500 milliseconds would still read as such.
 */
export function describeDuration(
  value: number,
  base: DurationUnit,
): { amount: number; unit: DurationUnit } {
  const units = DURATION_UNITS.filter((unit) => UNIT_MS[unit] >= UNIT_MS[base]);
  const unit = preferredDurationUnit(value, base, units);
  return { amount: value / factorOf(unit, base), unit };
}

/**
 * The unit a setting's value is stored in, read off its key, or `null` when
 * the key holds no duration. A naming convention, like `*Bytes`, so a duration
 * setting added later gets the unit field by itself. Keys ending in `Days`
 * are deliberately not durations here: a day is already the unit a person
 * means by a retention period, and they stay plain numbers.
 */
export function durationBaseOfSettingKey(key: string): DurationUnit | null {
  if (key.endsWith('Ms')) return 'milliseconds';
  if (key.endsWith('Seconds')) return 'seconds';
  if (key.endsWith('Minutes')) return 'minutes';
  return null;
}

/**
 * Whether a setting holds an hour of the day (0 to 23), shown as a time
 * rather than a number. The value has no minutes, so the control offers
 * none.
 */
export function isHourOfDaySettingKey(key: string): boolean {
  return key.endsWith('Hour');
}
