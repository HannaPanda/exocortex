import { describe, expect, it } from 'vitest';

import { clickRow, EMPTY_ROW_SELECTION, selectedInOrder, toggleAllRows } from './row-selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];

describe('row selection (issue #244)', () => {
  it('flips a single row and makes it the anchor', () => {
    const once = clickRow(EMPTY_ROW_SELECTION, ORDER, 'b', false);
    expect([...once.ids]).toEqual(['b']);
    expect(once.anchor).toBe('b');
    const twice = clickRow(once, ORDER, 'b', false);
    expect(twice.ids.size).toBe(0);
  });

  it('selects the range from the anchor with Shift, in either direction', () => {
    const anchored = clickRow(EMPTY_ROW_SELECTION, ORDER, 'b', false);
    expect(selectedInOrder(clickRow(anchored, ORDER, 'd', true), ORDER)).toEqual(['b', 'c', 'd']);
    const upward = clickRow(EMPTY_ROW_SELECTION, ORDER, 'd', false);
    expect(selectedInOrder(clickRow(upward, ORDER, 'a', true), ORDER)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('clears a range with Shift when the clicked row was selected', () => {
    let selection = toggleAllRows(EMPTY_ROW_SELECTION, ORDER);
    selection = clickRow(selection, ORDER, 'b', false);
    selection = clickRow(selection, ORDER, 'd', true);
    expect(selectedInOrder(selection, ORDER)).toEqual(['a', 'e']);
  });

  it('treats Shift without an anchor as a plain click', () => {
    const selection = clickRow(EMPTY_ROW_SELECTION, ORDER, 'c', true);
    expect(selectedInOrder(selection, ORDER)).toEqual(['c']);
  });

  it('selects every row shown, and clears when all already were', () => {
    const all = toggleAllRows(EMPTY_ROW_SELECTION, ORDER);
    expect(selectedInOrder(all, ORDER)).toEqual(ORDER);
    expect(toggleAllRows(all, ORDER).ids.size).toBe(0);
  });

  it('answers only with rows that are still shown', () => {
    const selection = toggleAllRows(EMPTY_ROW_SELECTION, ORDER);
    expect(selectedInOrder(selection, ['e', 'a', 'x'])).toEqual(['e', 'a']);
  });
});
