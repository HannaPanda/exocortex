import { describe, expect, it } from 'vitest';

import { DATABASE_COLUMN_MAX_WIDTH, DATABASE_COLUMN_MIN_WIDTH } from '@exocortex/contracts';

import { fittedColumnWidth } from './column-fit';

/**
 * The arithmetic of fitting a column (issue #277). The measuring itself needs
 * a browser laying out real cells, so it is proven in
 * `e2e/tests/database-column-fit.spec.ts`.
 */
describe('fittedColumnWidth', () => {
  it('takes the widest cell, header included, rounded up to a whole pixel', () => {
    expect(fittedColumnWidth([96.2, 241.3, 150])).toBe(242);
  });

  it('never goes below the narrowest column a view may store', () => {
    expect(fittedColumnWidth([12, 30])).toBe(DATABASE_COLUMN_MIN_WIDTH);
  });

  it('caps a very long value at the widest column a view may store', () => {
    expect(fittedColumnWidth([4000])).toBe(DATABASE_COLUMN_MAX_WIDTH);
  });

  it('gives a column with nothing to measure the narrowest width', () => {
    expect(fittedColumnWidth([])).toBe(DATABASE_COLUMN_MIN_WIDTH);
  });
});
