import { describe, expect, it } from 'vitest';

import { opensWithNewHistoryStep, peekAddress, peekIdOf } from './row-peek-address';

const PAGE = '/arbeitsbereich/ws/seite/db';

describe('peekIdOf', () => {
  it('reads the row from ?p=', () => {
    expect(peekIdOf(new URLSearchParams('p=row1'), 'db')).toBe('row1');
  });

  it('is null without the parameter or with an empty one', () => {
    expect(peekIdOf(new URLSearchParams(''), 'db')).toBeNull();
    expect(peekIdOf(new URLSearchParams('p='), 'db')).toBeNull();
  });

  it('never opens the page beside itself', () => {
    expect(peekIdOf(new URLSearchParams('p=db'), 'db')).toBeNull();
  });
});

describe('peekAddress', () => {
  it('adds the row to a bare address', () => {
    expect(peekAddress({ pathname: PAGE, search: '', hash: '' }, 'row1')).toBe(`${PAGE}?p=row1`);
  });

  it('replaces the row and keeps every other parameter and the hash', () => {
    expect(peekAddress({ pathname: PAGE, search: '?view=v1&p=row1', hash: '#block' }, 'row2')).toBe(
      `${PAGE}?view=v1&p=row2#block`,
    );
  });

  it('drops only the row when the panel closes', () => {
    expect(peekAddress({ pathname: PAGE, search: '?p=row1&view=v1', hash: '' }, null)).toBe(
      `${PAGE}?view=v1`,
    );
    expect(peekAddress({ pathname: PAGE, search: '?p=row1', hash: '' }, null)).toBe(PAGE);
  });
});

describe('opensWithNewHistoryStep', () => {
  it('pushes when the panel opens and replaces when it switches rows', () => {
    expect(opensWithNewHistoryStep(null)).toBe(true);
    expect(opensWithNewHistoryStep('row1')).toBe(false);
  });
});
