/**
 * Byte counts as a person writes them (issue #174).
 *
 * The API and the database keep bytes; only the settings form speaks in units.
 * Both families exist on purpose and are never mixed up: a decimal kilobyte is
 * 1000 bytes, a binary kibibyte 1024, and several defaults are binary
 * (`10 * 1024 * 1024`), so a form that offered only MB would have to show them
 * as 10.485760 and invite rounding them away.
 *
 * Conversion is exact in both directions. A unit is only ever chosen for
 * display when the stored value divides into it with at most three decimals,
 * and an amount typed in is only accepted when it names a whole number of
 * bytes, so opening and saving a form never moves a limit by a byte.
 */

export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'KiB', 'MiB', 'GiB'] as const;

export type ByteUnit = (typeof BYTE_UNITS)[number];

export const BYTE_UNIT_FACTORS: Record<ByteUnit, number> = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  KiB: 1_024,
  MiB: 1_024 ** 2,
  GiB: 1_024 ** 3,
};

/** Largest first, binary before decimal of the same rank. */
const DISPLAY_ORDER: readonly ByteUnit[] = ['GiB', 'GB', 'MiB', 'MB', 'KiB', 'KB', 'B'];

/** How many decimals a displayed amount may carry before a smaller unit is used. */
const DISPLAY_DECIMALS = 3;

/**
 * The unit a stored byte count is shown in: the largest one in which it is at
 * least 1 and exact to three decimals. `500000000` is 500 MB, `10485760` is
 * 10 MiB, and a count no unit divides stays in bytes.
 */
export function preferredByteUnit(bytes: number): ByteUnit {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return 'B';
  const scaled = BigInt(bytes) * BigInt(10 ** DISPLAY_DECIMALS);
  for (const unit of DISPLAY_ORDER) {
    const factor = BYTE_UNIT_FACTORS[unit];
    if (bytes >= factor && scaled % BigInt(factor) === BigInt(0)) return unit;
  }
  return 'B';
}

/**
 * The amount of `unit` a byte count is, as plain decimal text (`"1.5"`), the
 * form an `<input type="number">` takes. Exact whenever `unit` came from
 * `preferredByteUnit`.
 */
export function amountInUnit(bytes: number, unit: ByteUnit): string {
  return String(bytes / BYTE_UNIT_FACTORS[unit]);
}

/**
 * The byte count an amount typed in names, or `null` when it is not one.
 *
 * Decimal text is multiplied out with integers rather than floats, so
 * `0.1 MB` is exactly 100000 and not 100000.00000000001. An amount that lands
 * between two bytes (`1.0001 KB`) is refused instead of rounded: a rounded
 * value would be saved as something the field never showed.
 */
export function bytesFromAmount(amount: string, unit: ByteUnit): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const scale = BigInt(10) ** BigInt(fraction.length);
  const product = BigInt(whole + fraction) * BigInt(BYTE_UNIT_FACTORS[unit]);
  if (product % scale !== BigInt(0)) return null;
  const bytes = product / scale;
  return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(bytes);
}

/** A byte count in the unit it reads best in, for running text. */
export function describeBytes(bytes: number): { amount: number; unit: ByteUnit } {
  const unit = preferredByteUnit(bytes);
  return { amount: bytes / BYTE_UNIT_FACTORS[unit], unit };
}

/**
 * Whether a setting holds a byte count. A naming convention, like
 * `*ModelSlug`, so a byte setting added later gets the unit field by itself.
 */
export function isByteSettingKey(key: string): boolean {
  return key.endsWith('Bytes');
}
