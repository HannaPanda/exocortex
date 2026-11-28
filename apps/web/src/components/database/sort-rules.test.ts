import { describe, expect, it } from 'vitest';

import { DATABASE_TITLE_COLUMN_KEY, type DatabaseSort } from '@exocortex/contracts';

import { databaseProperty } from '@/test-support/database';

import {
  dropIndex,
  moveSort,
  nextUnsortedColumn,
  sortableColumns,
  sortByColumn,
  sortOf,
  withColumn,
  withDirection,
  withoutColumn,
} from './sort-rules';

const byDate: DatabaseSort = { propertyId: 'date', direction: 'desc' };
const byName: DatabaseSort = { propertyId: DATABASE_TITLE_COLUMN_KEY, direction: 'asc' };
const byStatus: DatabaseSort = { propertyId: 'status', direction: 'asc' };

describe('sortableColumns', () => {
  it('offers the name first, then the properties in their order', () => {
    const columns = sortableColumns('Name', [databaseProperty('date'), databaseProperty('status')]);
    expect(columns.map((column) => column.key)).toEqual([
      DATABASE_TITLE_COLUMN_KEY,
      'date',
      'status',
    ]);
  });
});

describe('sortByColumn', () => {
  it('appends a new column as the lowest priority: by date, then by name', () => {
    const first = sortByColumn([], 'date', 'desc');
    expect(sortByColumn(first, DATABASE_TITLE_COLUMN_KEY, 'asc')).toEqual([byDate, byName]);
  });

  it('turns an existing rule around in place instead of moving it to the end', () => {
    expect(sortByColumn([byDate, byName], 'date', 'asc')).toEqual([
      { propertyId: 'date', direction: 'asc' },
      byName,
    ]);
  });

  it('leaves the list it was given alone', () => {
    const sorts = [byDate];
    sortByColumn(sorts, 'date', 'asc');
    expect(sorts).toEqual([byDate]);
  });
});

describe('sortOf', () => {
  it('names the priority and direction of a sorted column, and null otherwise', () => {
    expect(sortOf([byDate, byName], DATABASE_TITLE_COLUMN_KEY)).toEqual({
      index: 1,
      direction: 'asc',
    });
    expect(sortOf([byDate], 'status')).toBeNull();
  });
});

describe('editing one rule', () => {
  it('changes the direction of one rule only', () => {
    expect(withDirection([byDate, byName], 1, 'desc')).toEqual([
      byDate,
      { propertyId: DATABASE_TITLE_COLUMN_KEY, direction: 'desc' },
    ]);
  });

  it('removes a column wherever it stands', () => {
    expect(withoutColumn([byDate, byName, byStatus], DATABASE_TITLE_COLUMN_KEY)).toEqual([
      byDate,
      byStatus,
    ]);
  });

  it('points a rule at another column and drops the rule that sorted by it before', () => {
    expect(withColumn([byDate, byName, byStatus], 0, 'status')).toEqual([
      { propertyId: 'status', direction: 'desc' },
      byName,
    ]);
  });
});

describe('moveSort', () => {
  it('moves a rule up and down the priority list', () => {
    expect(moveSort([byDate, byName, byStatus], 2, 0)).toEqual([byStatus, byDate, byName]);
    expect(moveSort([byDate, byName, byStatus], 0, 1)).toEqual([byName, byDate, byStatus]);
  });

  it('changes nothing for a move past either end', () => {
    expect(moveSort([byDate, byName], 0, -1)).toEqual([byDate, byName]);
    expect(moveSort([byDate, byName], 1, 2)).toEqual([byDate, byName]);
  });
});

describe('nextUnsortedColumn', () => {
  const columns = sortableColumns('Name', [databaseProperty('date')]);

  it('starts a new rule on the first column nothing sorts by', () => {
    expect(nextUnsortedColumn(columns, [byName])?.key).toBe('date');
  });

  it('has nothing left once every column is sorted', () => {
    expect(nextUnsortedColumn(columns, [byName, byDate])).toBeNull();
  });
});

describe('dropIndex', () => {
  // Three rows, 32 px apart, centres at 16, 48 and 80.
  const midpoints = [16, 48, 80];

  it('stays in place while the pointer has passed no other row', () => {
    expect(dropIndex(midpoints, 1, 30)).toBe(1);
    expect(dropIndex(midpoints, 0, 40)).toBe(0);
  });

  it('counts the rows the pointer has passed, without the dragged one', () => {
    expect(dropIndex(midpoints, 0, 60)).toBe(1);
    expect(dropIndex(midpoints, 0, 95)).toBe(2);
    expect(dropIndex(midpoints, 2, 5)).toBe(0);
    expect(dropIndex(midpoints, 2, 30)).toBe(1);
  });
});
