import { describe, expect, it } from 'vitest';

import {
  DATABASE_COLUMN_DEFAULT_WIDTH,
  DATABASE_COLUMN_MAX_WIDTH,
  DATABASE_COLUMN_MIN_WIDTH,
} from '@exocortex/contracts';

import { databaseProperty, databaseView, visibleProperties } from '@/test-support/database';

import {
  clampColumnWidth,
  columnMoveAfter,
  columnWidthOf,
  hasOwnColumnOrder,
  moveColumnInView,
  rowHeightOf,
  toggleColumnVisibility,
  visibleTableProperties,
} from './table-columns';

const properties = [databaseProperty('p1'), databaseProperty('p2'), databaseProperty('p3')];

/** What the helpers return, as the ids and flags a reader can compare. */
function entries(
  list: ReturnType<typeof toggleColumnVisibility> | null,
): [string, boolean][] | null {
  return list?.map((entry) => [entry.propertyId, entry.visible]) ?? null;
}

describe('rowHeightOf and columnWidthOf', () => {
  it('fall back to the defaults a view never stored', () => {
    expect(rowHeightOf(databaseView())).toBe('short');
    expect(columnWidthOf(databaseView(), 'p1')).toBe(DATABASE_COLUMN_DEFAULT_WIDTH);
  });

  it('read what the view does store', () => {
    const view = databaseView({ rowHeight: 'tall', columnWidths: { p1: 300 } });

    expect(rowHeightOf(view)).toBe('tall');
    expect(columnWidthOf(view, 'p1')).toBe(300);
  });
});

describe('clampColumnWidth', () => {
  it('keeps a column between the bounds and on whole pixels', () => {
    expect(clampColumnWidth(10)).toBe(DATABASE_COLUMN_MIN_WIDTH);
    expect(clampColumnWidth(10_000)).toBe(DATABASE_COLUMN_MAX_WIDTH);
    expect(clampColumnWidth(220.4)).toBe(220);
  });
});

describe('visibleTableProperties', () => {
  it('shows every property in database order while the view has no list', () => {
    expect(visibleTableProperties(databaseView(), properties).map((p) => p.id)).toEqual([
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('hides what the view marked hidden and follows the view order', () => {
    const view = databaseView({
      visibleProperties: visibleProperties([
        ['p3', true],
        ['p2', false],
        ['p1', true],
      ]),
    });

    expect(visibleTableProperties(view, properties).map((p) => p.id)).toEqual(['p3', 'p1']);
  });

  it('appends a property the view has never heard of', () => {
    // A freshly created property appears without the view being touched, which
    // is what keeps "add a column" a one-step action.
    const view = databaseView({
      visibleProperties: visibleProperties([
        ['p2', true],
        ['p1', true],
      ]),
    });

    expect(visibleTableProperties(view, properties).map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
  });

  it('ignores a list entry for a property that is gone', () => {
    const view = databaseView({
      visibleProperties: visibleProperties([
        ['deleted', true],
        ['p1', true],
      ]),
    });

    expect(visibleTableProperties(view, properties).map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('toggleColumnVisibility', () => {
  it('writes the whole layout, not only the toggled column', () => {
    expect(entries(toggleColumnVisibility(databaseView(), properties, 'p2'))).toEqual([
      ['p1', true],
      ['p2', false],
      ['p3', true],
    ]);
  });

  it('brings a hidden column back at the end of the visible ones', () => {
    const view = databaseView({
      visibleProperties: visibleProperties([
        ['p1', true],
        ['p2', false],
        ['p3', true],
      ]),
    });

    expect(entries(toggleColumnVisibility(view, properties, 'p2'))).toEqual([
      ['p1', true],
      ['p3', true],
      ['p2', true],
    ]);
  });

  it('keeps the order keys dense and sortable as strings', () => {
    const written = toggleColumnVisibility(databaseView(), properties, 'p1');

    expect(written.map((entry) => entry.orderKey)).toEqual(['0000', '0001', '0002']);
  });
});

describe('columnMoveAfter', () => {
  it('moves a column one place to the right', () => {
    expect(columnMoveAfter(properties, 'p1', 'right')).toEqual({ afterPropertyId: 'p2' });
  });

  it('moves a column one place to the left', () => {
    expect(columnMoveAfter(properties, 'p3', 'left')).toEqual({ afterPropertyId: 'p1' });
  });

  it('moves the second column to the front', () => {
    expect(columnMoveAfter(properties, 'p2', 'left')).toEqual({ afterPropertyId: null });
  });

  it('refuses a step past either end', () => {
    expect(columnMoveAfter(properties, 'p1', 'left')).toBeNull();
    expect(columnMoveAfter(properties, 'p3', 'right')).toBeNull();
    expect(columnMoveAfter(properties, 'nope', 'left')).toBeNull();
  });
});

describe('moveColumnInView', () => {
  const view = databaseView({
    visibleProperties: visibleProperties([
      ['p1', true],
      ['p2', false],
      ['p3', true],
    ]),
  });

  it('swaps two visible columns and leaves the hidden one behind them', () => {
    expect(entries(moveColumnInView(view, properties, 'p1', 'right'))).toEqual([
      ['p3', true],
      ['p1', true],
      ['p2', false],
    ]);
  });

  it('steps over a hidden column, because a person cannot see it', () => {
    expect(entries(moveColumnInView(view, properties, 'p3', 'left'))).toEqual([
      ['p3', true],
      ['p1', true],
      ['p2', false],
    ]);
  });

  it('refuses a step past either end', () => {
    expect(moveColumnInView(view, properties, 'p1', 'left')).toBeNull();
    expect(moveColumnInView(view, properties, 'p3', 'right')).toBeNull();
  });

  it('refuses to move a column the view hides', () => {
    expect(moveColumnInView(view, properties, 'p2', 'left')).toBeNull();
  });
});

describe('hasOwnColumnOrder', () => {
  it('is false until something writes a layout', () => {
    expect(hasOwnColumnOrder(databaseView())).toBe(false);
    expect(
      hasOwnColumnOrder(databaseView({ visibleProperties: visibleProperties([['p1', true]]) })),
    ).toBe(true);
  });
});
