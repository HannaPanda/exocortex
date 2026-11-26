import { describe, expect, it } from 'vitest';

import { anchorTop, spacerHeight } from './transcript-anchor';

describe('anchorTop', () => {
  it('puts a short question at the top, below the padding', () => {
    expect(anchorTop({ top: 812, bottom: 860 }, 12, 600)).toBe(800);
  });

  it('keeps two thirds of the view for the answer below a long question', () => {
    // A question of 500px in a 600px view: its end stands at 200px.
    expect(anchorTop({ top: 812, bottom: 1312 }, 12, 600)).toBe(1112);
  });

  it('never scrolls above the start', () => {
    expect(anchorTop({ top: 4, bottom: 40 }, 12, 600)).toBe(0);
  });
});

describe('spacerHeight', () => {
  it('makes room under a short answer so the question can reach the top', () => {
    // Content ends 100px below the question: 700 tall, view 600, target 600.
    expect(spacerHeight({ target: 600, scrollHeight: 700, clientHeight: 600, spacer: 0 })).toBe(
      500,
    );
  });

  it('shrinks the room as the answer grows', () => {
    // The answer grew by 200px while 500px of room stood under it.
    expect(spacerHeight({ target: 600, scrollHeight: 1400, clientHeight: 600, spacer: 500 })).toBe(
      300,
    );
  });

  it('is gone once the answer fills the view', () => {
    expect(spacerHeight({ target: 600, scrollHeight: 2400, clientHeight: 600, spacer: 300 })).toBe(
      0,
    );
  });

  it('grows again when something under the question folds away', () => {
    expect(spacerHeight({ target: 600, scrollHeight: 1000, clientHeight: 600, spacer: 0 })).toBe(
      200,
    );
  });
});
