import { describe, expect, it } from 'vitest';

import {
  CONTEXT_MIN_WIDTH,
  CONTEXT_PAGE_KEEPS,
  parsePanelPreference,
  resolveContextWidth,
} from './panel-preferences';

describe('resolveContextWidth', () => {
  it('lets the panel grow well past the old 520 px on a wide screen', () => {
    // 1920 px window, 272 px navigation.
    expect(resolveContextWidth(900, 1648)).toEqual({
      width: 900,
      min: CONTEXT_MIN_WIDTH,
      max: 1648 - CONTEXT_PAGE_KEEPS,
    });
  });

  it('leaves the page its readable width when the room shrinks under a stored width', () => {
    expect(resolveContextWidth(900, 1000).width).toBe(1000 - CONTEXT_PAGE_KEEPS);
  });

  it('never draws the panel narrower than its minimum', () => {
    expect(resolveContextWidth(100, 1648).width).toBe(CONTEXT_MIN_WIDTH);
    expect(resolveContextWidth(400, 600)).toEqual({
      width: CONTEXT_MIN_WIDTH,
      min: CONTEXT_MIN_WIDTH,
      max: CONTEXT_MIN_WIDTH,
    });
  });

  it('draws the stored width until the room is measured', () => {
    expect(resolveContextWidth(700, 0)).toEqual({ width: 700, min: CONTEXT_MIN_WIDTH, max: 700 });
  });
});

describe('parsePanelPreference', () => {
  it('reads what the shell writes', () => {
    expect(parsePanelPreference('{"open":false,"width":812}')).toEqual({
      open: false,
      width: 812,
    });
  });
});
