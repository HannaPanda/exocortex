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
 * Appending and prepending do not use the midpoint (issue #221). Halving the
 * gap to the end of the list costs about a bit per key, so the key at the end
 * of a list grew one character every five appends: 2,000 characters after
 * 10,000 rows, 76 in a real agent memory branch of 380 pages. `stepAfter` and
 * `stepBefore` count up or down instead, in blocks that get one character
 * longer each time one fills up, so 10,000 appends end at 5 characters and a
 * million at 9. Greenspan's own answer is an integer head in front of the
 * fraction; that would be a second key format beside the one every stored row
 * already has, and this keeps the one format.
 *
 * Invariants:
 *  * a key never ends with the smallest digit (`0`), which keeps midpoints finite
 *  * `midpoint(a, b)` throws when `a >= b`
 */

export const ORDER_KEY_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const SMALLEST_DIGIT = ORDER_KEY_DIGITS[0] as string;
const LARGEST_DIGIT = ORDER_KEY_DIGITS[ORDER_KEY_DIGITS.length - 1] as string;

/**
 * The widest counter a step works in. A block of three digits holds about
 * 230,000 keys, after which the key grows by one character; a narrower one
 * would grow it sooner, a wider one makes every key of a short list longer.
 */
const MAX_STEP_DIGITS = 3;

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
  if (before !== null && after === null) return stepAfter(before);
  if (before === null && after !== null) return stepBefore(after);
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

/**
 * The next key after `key`, by counting rather than halving.
 *
 * Any key above `key` has to start with the same run of `z`s, because `z` is
 * the largest digit. Below that run sits a counter of `j + 1` digits (at most
 * `MAX_STEP_DIGITS`), read from what follows the run: cut to that width, or
 * padded with `0`s, and then counted up by one. Counting up a cut-off prefix
 * lands above every key that starts with it; counting up a padded one lands
 * above the shorter key it was padded from. When the counter reaches `z` the
 * next call sees one more `z` in the run, which is what makes the length grow
 * with the logarithm of the list rather than with the list.
 */
function stepAfter(key: string): string {
  const run = leadingRun(key, LARGEST_DIGIT);
  let counter = counterOf(key.slice(run), Math.min(run + 1, MAX_STEP_DIGITS));
  do {
    counter = countBy(counter, 1);
  } while (counter.endsWith(SMALLEST_DIGIT));
  return LARGEST_DIGIT.repeat(run) + counter;
}

/**
 * The mirror image of `stepAfter`, below `key`: the run is of `0`s, and the
 * counter counts down. A counter that would reach zero cannot end the key, so
 * the block below it starts instead, one `0` further in.
 */
function stepBefore(key: string): string {
  const run = leadingRun(key, SMALLEST_DIGIT);
  const width = Math.min(run + 1, MAX_STEP_DIGITS);
  let counter = counterOf(key.slice(run), width);
  do {
    counter = countBy(counter, -1);
  } while (counter.endsWith(SMALLEST_DIGIT) && !isZero(counter));
  if (isZero(counter)) {
    return (
      SMALLEST_DIGIT.repeat(run + 1) + LARGEST_DIGIT.repeat(Math.min(run + 2, MAX_STEP_DIGITS))
    );
  }
  return SMALLEST_DIGIT.repeat(run) + counter;
}

function leadingRun(key: string, digit: string): number {
  let length = 0;
  while (key[length] === digit) length += 1;
  return length;
}

function counterOf(rest: string, width: number): string {
  return rest.length >= width ? rest.slice(0, width) : rest.padEnd(width, SMALLEST_DIGIT);
}

function isZero(counter: string): boolean {
  return [...counter].every((digit) => digit === SMALLEST_DIGIT);
}

/**
 * Adds `delta` (1 or -1) to a fixed-width base62 number. The callers never
 * pass a counter that would carry out of its width: its first digit is never
 * `z` when counting up (that digit would belong to the run) and never `0`
 * when counting down.
 */
function countBy(counter: string, delta: 1 | -1): string {
  const digits = [...counter].map((digit) => ORDER_KEY_DIGITS.indexOf(digit));
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const next = (digits[index] as number) + delta;
    if (next >= 0 && next < ORDER_KEY_DIGITS.length) {
      digits[index] = next;
      return digits.map((digit) => ORDER_KEY_DIGITS[digit] as string).join('');
    }
    digits[index] = delta > 0 ? 0 : ORDER_KEY_DIGITS.length - 1;
  }
  throw new OrderKeyError(`order key counter overflowed: ${counter}`);
}
