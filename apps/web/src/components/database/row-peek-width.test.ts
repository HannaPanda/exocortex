import { describe, expect, it } from 'vitest';

import {
  parseRowPeekWidth,
  resolveRowPeekWidth,
  ROW_PEEK_MIN_WIDTH,
  ROW_PEEK_TABLE_KEEPS,
} from './row-peek-width';

describe('resolveRowPeekWidth', () => {
  it('is about half the page area between 26 and 44 rem without a width of its own', () => {
    expect(resolveRowPeekWidth(null, 1000).width).toBe(480);
    expect(resolveRowPeekWidth(null, 700).width).toBe(416);
    expect(resolveRowPeekWidth(null, 2000).width).toBe(704);
  });

  it('keeps a dragged width inside the limits', () => {
    expect(resolveRowPeekWidth(600, 1200)).toEqual({ width: 600, min: 360, max: 960 });
  });

  it('never drops below the minimum the properties need', () => {
    expect(resolveRowPeekWidth(200, 1200).width).toBe(ROW_PEEK_MIN_WIDTH);
  });

  it('leaves the table its strip when the page area shrinks under a stored width', () => {
    expect(resolveRowPeekWidth(1100, 1000).width).toBe(1000 - ROW_PEEK_TABLE_KEEPS);
  });

  it('lets the minimum win where the area is too narrow for both', () => {
    expect(resolveRowPeekWidth(500, 400)).toEqual({ width: 360, min: 360, max: 360 });
  });
});

describe('parseRowPeekWidth', () => {
  it('reads a stored width', () => {
    expect(parseRowPeekWidth('{"width":512}')).toEqual({ width: 512 });
  });

  it('falls back to the default for anything else', () => {
    expect(parseRowPeekWidth('{"width":null}')).toEqual({ width: null });
    expect(parseRowPeekWidth('{"width":"wide"}')).toEqual({ width: null });
    expect(parseRowPeekWidth('{"width":-3}')).toEqual({ width: null });
    expect(parseRowPeekWidth('null')).toEqual({ width: null });
  });
});
