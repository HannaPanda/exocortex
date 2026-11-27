import { describe, expect, it } from 'vitest';

import { type DatabaseRowPropertyValue } from '@exocortex/contracts';

import { databaseProperty } from '@/test-support/database';

import {
  isEmptyCellValue,
  layoutRowHeader,
  ROW_HEADER_LEADING,
  ROW_HEADER_MAX,
  ROW_HEADER_SHOW_ALL_UP_TO,
} from './row-header-layout';

type CellValue = DatabaseRowPropertyValue['value'];

function schema(count: number) {
  return Array.from({ length: count }, (_, index) => databaseProperty(`p${index}`));
}

function layout(count: number, filled: Record<string, CellValue>, readOnly: boolean) {
  const result = layoutRowHeader({
    properties: schema(count),
    valueOf: (id) => filled[id] ?? null,
    readOnly,
  });
  return {
    shown: result.shown.map((property) => property.id),
    folded: result.folded.map((property) => property.id),
  };
}

describe('isEmptyCellValue', () => {
  it('treats nothing, blank text and an empty list as empty, and false and 0 as values', () => {
    expect(isEmptyCellValue(null)).toBe(true);
    expect(isEmptyCellValue(undefined)).toBe(true);
    expect(isEmptyCellValue('  ')).toBe(true);
    expect(isEmptyCellValue([])).toBe(true);
    expect(isEmptyCellValue(false)).toBe(false);
    expect(isEmptyCellValue(0)).toBe(false);
    expect(isEmptyCellValue(['a'])).toBe(false);
  });
});

describe('layoutRowHeader (issue #254)', () => {
  it('shows a short schema whole to an editor, empty fields included', () => {
    const result = layout(ROW_HEADER_SHOW_ALL_UP_TO, {}, false);
    expect(result.shown).toHaveLength(ROW_HEADER_SHOW_ALL_UP_TO);
    expect(result.folded).toEqual([]);
  });

  it('folds the empty tail of a long schema, keeping filled columns in their place', () => {
    const result = layout(20, { p15: 'Wert', p3: 'früh' }, false);
    expect(result.shown).toEqual([
      ...Array.from({ length: ROW_HEADER_LEADING }, (_, index) => `p${index}`),
      'p15',
    ]);
    expect(result.folded).toHaveLength(20 - ROW_HEADER_LEADING - 1);
    expect(result.folded).not.toContain('p15');
  });

  it('shows a reader only what is filled, the rest one click away', () => {
    const result = layout(5, { p1: 3, p4: true }, true);
    expect(result.shown).toEqual(['p1', 'p4']);
    expect(result.folded).toEqual(['p0', 'p2', 'p3']);
  });

  it('never folds a single line behind a button', () => {
    const result = layout(3, { p0: 'a', p1: 'b' }, true);
    expect(result.shown).toEqual(['p0', 'p1', 'p2']);
    expect(result.folded).toEqual([]);
  });

  it('caps a header full of values at the maximum', () => {
    const filled = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`p${index}`, 'x'] as const),
    );
    const result = layout(30, filled, true);
    expect(result.shown).toHaveLength(ROW_HEADER_MAX);
    expect(result.shown[0]).toBe('p0');
    expect(result.folded).toHaveLength(30 - ROW_HEADER_MAX);
  });

  it('shows nothing for a reader of a row without any value', () => {
    const result = layout(4, {}, true);
    expect(result.shown).toEqual([]);
    expect(result.folded).toHaveLength(4);
  });
});
