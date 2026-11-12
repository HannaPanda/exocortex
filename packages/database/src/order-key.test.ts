import { describe, expect, it } from 'vitest';

import {
  generateOrderKey,
  initialOrderKey,
  orderKeyAfter,
  orderKeyBefore,
  OrderKeyError,
  orderKeySequence,
} from './order-key';

/** How much longer than its neighbour a stepped key may be. */
const MAX_GROWTH = 3;

describe('generateOrderKey', () => {
  it('creates a deterministic first key', () => {
    expect(initialOrderKey()).toBe('V');
  });

  it('appends after an existing key', () => {
    const first = initialOrderKey();
    const second = orderKeyAfter(first);
    expect(second > first).toBe(true);
  });

  it('prepends before an existing key', () => {
    const first = initialOrderKey();
    const zeroth = orderKeyBefore(first);
    expect(zeroth < first).toBe(true);
  });

  it('inserts strictly between two neighbours', () => {
    const a = initialOrderKey();
    const b = orderKeyAfter(a);
    const between = generateOrderKey(a, b);
    expect(between > a).toBe(true);
    expect(between < b).toBe(true);
  });

  it('survives repeated insertion at the same position without renumbering', () => {
    let lower = initialOrderKey();
    const upper = orderKeyAfter(lower);
    const generated: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const key = generateOrderKey(lower, upper);
      expect(key > lower).toBe(true);
      expect(key < upper).toBe(true);
      generated.push(key);
      lower = key;
    }
    // Every key is unique and the sequence is strictly increasing.
    expect(new Set(generated).size).toBe(generated.length);
    expect([...generated].sort()).toEqual(generated);
  });

  it('keeps lexicographic order for a long appended sequence', () => {
    const keys = orderKeySequence(500);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });

  it('keeps lexicographic order for a long prepended sequence', () => {
    const keys: string[] = [];
    let first: string | null = null;
    for (let index = 0; index < 200; index += 1) {
      first = orderKeyBefore(first);
      keys.unshift(first);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it('grows logarithmically, not linearly, when appending (issue #221)', () => {
    let key = initialOrderKey();
    let longest = key.length;
    for (let index = 0; index < 10_000; index += 1) {
      const next = orderKeyAfter(key);
      expect(next > key).toBe(true);
      expect(next.endsWith('0')).toBe(false);
      key = next;
      longest = Math.max(longest, key.length);
    }
    // The midpoint version ended at 2,000 characters here.
    expect(longest).toBeLessThanOrEqual(5);
  });

  it('grows logarithmically when prepending', () => {
    let key = initialOrderKey();
    let longest = key.length;
    for (let index = 0; index < 10_000; index += 1) {
      const next = orderKeyBefore(key);
      expect(next < key).toBe(true);
      expect(next.endsWith('0')).toBe(false);
      key = next;
      longest = Math.max(longest, key.length);
    }
    expect(longest).toBeLessThanOrEqual(6);
  });

  it('steps past keys of any shape without growing them', () => {
    // Keys the midpoint version left behind, and the rebalanced ones.
    for (const key of [
      'V',
      'a0V',
      'zzzzt',
      `${'z'.repeat(70)}V`,
      '1',
      '01',
      '0001',
      'y',
      'z',
      'V0CF',
    ]) {
      const after = orderKeyAfter(key);
      const before = orderKeyBefore(key);
      expect(after > key).toBe(true);
      expect(before < key).toBe(true);
      expect(after.endsWith('0') || before.endsWith('0')).toBe(false);
      expect(after.length).toBeLessThanOrEqual(key.length + MAX_GROWTH);
      expect(before.length).toBeLessThanOrEqual(key.length + MAX_GROWTH);
    }
  });

  it('rejects inverted bounds', () => {
    expect(() => generateOrderKey('b', 'a')).toThrowError(OrderKeyError);
    expect(() => generateOrderKey('a', 'a')).toThrowError(OrderKeyError);
  });

  it('rejects invalid characters', () => {
    expect(() => generateOrderKey('a-b', null)).toThrowError(OrderKeyError);
  });

  it('rejects keys ending in the smallest digit', () => {
    expect(() => generateOrderKey('a0', null)).toThrowError(OrderKeyError);
  });

  it('never produces a key ending in the smallest digit', () => {
    let lower = initialOrderKey();
    const upper = orderKeyAfter(lower);
    for (let index = 0; index < 100; index += 1) {
      lower = generateOrderKey(lower, upper);
      expect(lower.endsWith('0')).toBe(false);
    }
  });
});
