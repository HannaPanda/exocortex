import { describe, expect, it } from 'vitest';

import {
  generateOrderKey,
  initialOrderKey,
  orderKeyAfter,
  orderKeyBefore,
  OrderKeyError,
  orderKeySequence,
} from './order-key';

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
