import { describe, expect, it } from 'vitest';

import {
  filtersMentionProperty,
  filtersWithoutProperty,
  sortsWithoutProperty,
} from './database-view-scrub';
import { DATABASE_TITLE_COLUMN_KEY, type DatabaseFilterGroup } from './database-views';

const GONE = 'prop_gone_1';
const KEPT = 'prop_kept_1';

describe('sortsWithoutProperty', () => {
  it('drops the rule for the column and keeps the others in their order', () => {
    expect(
      sortsWithoutProperty(
        [
          { propertyId: KEPT, direction: 'desc' },
          { propertyId: GONE, direction: 'asc' },
          { propertyId: DATABASE_TITLE_COLUMN_KEY, direction: 'asc' },
        ],
        GONE,
      ),
    ).toEqual([
      { propertyId: KEPT, direction: 'desc' },
      { propertyId: DATABASE_TITLE_COLUMN_KEY, direction: 'asc' },
    ]);
  });
});

describe('filtersWithoutProperty', () => {
  const tree: DatabaseFilterGroup = {
    combinator: 'and',
    conditions: [
      { propertyId: KEPT, operator: 'is_not_empty' },
      {
        combinator: 'or',
        conditions: [
          { propertyId: GONE, operator: 'equals', value: 'x' },
          { propertyId: GONE, operator: 'is_empty' },
        ],
      },
      {
        combinator: 'or',
        conditions: [
          { propertyId: GONE, operator: 'is_empty' },
          { propertyId: KEPT, operator: 'equals', value: 'y' },
        ],
      },
    ],
  };

  it('drops every condition naming the column, and a group it leaves empty', () => {
    expect(filtersWithoutProperty(tree, GONE)).toEqual({
      combinator: 'and',
      conditions: [
        { propertyId: KEPT, operator: 'is_not_empty' },
        { combinator: 'or', conditions: [{ propertyId: KEPT, operator: 'equals', value: 'y' }] },
      ],
    });
  });

  it('says whether the tree names the column at all', () => {
    expect(filtersMentionProperty(tree, GONE)).toBe(true);
    expect(filtersMentionProperty(filtersWithoutProperty(tree, GONE), GONE)).toBe(false);
  });
});
