/**
 * Fractional indexing for stable sibling ordering.
 *
 * An order key is a non-empty base62 string. For any two keys `a < b` a new key
 * strictly between them can be generated without touching any other row, so
 * inserting between siblings never renumbers the tree.
 *
 * Implementation follows the well-known "midpoint" algorithm (David Greenspan,
 * "Implementing Fractional Indexing"), restricted to the fractional part only:
 * keys are compared as plain strings, which matches PostgreSQL's default
 * `text` ordering when the database uses the C collation for this column.
 *
 * Invariants:
 *  * a key never ends with the smallest digit (`0`), which keeps midpoints finite
 *  * `midpoint(a, b)` throws when `a >= b`
 */

export const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const SMALLEST_DIGIT = ORDER_KEY_DIGITS[0] as string;

export class OrderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderKeyError';
  }
}

function assertValidKey(key: string, label: string): void {
  if (key.length === 0) {
    throw new OrderKeyError(`${label} must not be empty`);
  }
  for (const character of key) {
    if (!ORDER_KEY_DIGITS.includes(character)) {
      throw new OrderKeyError(`${label} contains a non-base62 character: ${character}`);
    }
  }
  if (key.endsWith(SMALLEST_DIGIT)) {
    throw new OrderKeyError(`${label} must not end with "${SMALLEST_DIGIT}": ${key}`);
  }
}

/**
 * Returns a key strictly between `before` and `after`.
 *
 * @param before lower bound, or `null` for "beginning of the list"
 * @param after upper bound, or `null` for "end of the list"
 */
export function generateOrderKey(before: string | null, after: string | null): string {
  if (before !== null) assertValidKey(before, 'before');
  if (after !== null) assertValidKey(after, 'after');
  if (before !== null && after !== null && before >= after) {
    throw new OrderKeyError(
      `before must be strictly smaller than after (got "${before}" and "${after}")`,
    );
  }
  return midpoint(before ?? '', after);
}

/** Convenience helper: append to the end of a sibling list. */
export function orderKeyAfter(last: string | null): string {
  return generateOrderKey(last, null);
}

/** Convenience helper: prepend to the start of a sibling list. */
export function orderKeyBefore(first: string | null): string {
  return generateOrderKey(null, first);
}

/** The very first key of an empty list. */
export function initialOrderKey(): string {
  return generateOrderKey(null, null);
}

/**
 * Generates `count` increasing keys after `last`. Used by seeding and Markdown
 * import when several siblings are created at once.
 */
export function orderKeySequence(count: number, last: string | null = null): string[] {
  const keys: string[] = [];
  let cursor = last;
  for (let index = 0; index < count; index += 1) {
    cursor = generateOrderKey(cursor, null);
    keys.push(cursor);
  }
  return keys;
}

function midpoint(lower: string, upper: string | null): string {
  if (upper !== null && lower >= upper) {
    throw new OrderKeyError(`invalid midpoint bounds: "${lower}" >= "${upper}"`);
  }

  if (upper !== null) {
    // Copy the shared prefix and recurse on the remainder.
    let shared = 0;
    while (shared < upper.length && (lower[shared] ?? SMALLEST_DIGIT) === upper[shared]) {
      shared += 1;
    }
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared));
    }
  }

  const lowerDigit = lower.length > 0 ? ORDER_KEY_DIGITS.indexOf(lower[0] as string) : 0;
  const upperDigit =
    upper !== null ? ORDER_KEY_DIGITS.indexOf(upper[0] as string) : ORDER_KEY_DIGITS.length;

  if (upperDigit - lowerDigit > 1) {
    const middle = Math.round((lowerDigit + upperDigit) / 2);
    return ORDER_KEY_DIGITS[middle] as string;
  }

  // Digits are adjacent: descend into the lower key.
  if (upper !== null && upper.length > 1) {
    return upper.slice(0, 1);
  }
  return (ORDER_KEY_DIGITS[lowerDigit] as string) + midpoint(lower.slice(1), null);
}
