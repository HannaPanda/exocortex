import { describe, expect, it } from 'vitest';

import { type PageOutlineEntry } from '@exocortex/editor';

import {
  activeHeadingIndex,
  activeTickIndex,
  outlinePlacement,
  outlineWanted,
  PINNED_WIDTH,
  railTicks,
} from './outline-geometry';

function entry(level: number, hiddenUnder: string | null = null): PageOutlineEntry {
  return { level, text: `H${String(level)}`, blockId: null, collapsed: false, hiddenUnder };
}

describe('activeHeadingIndex', () => {
  const tops = [300, 900, null, 1800, 2600];
  const page = { viewportHeight: 600, scrollHeight: 3000 };

  it('names no section above the first heading', () => {
    expect(activeHeadingIndex(tops, { ...page, scrollTop: 0 })).toBeNull();
  });

  it('switches only once a heading has risen past the reading line', () => {
    // The line sits 180 px down: 900 is current from scrollTop 720 on.
    expect(activeHeadingIndex(tops, { ...page, scrollTop: 719 })).toBe(0);
    expect(activeHeadingIndex(tops, { ...page, scrollTop: 720 })).toBe(1);
  });

  it('skips a heading that is not drawn', () => {
    expect(activeHeadingIndex(tops, { ...page, scrollTop: 1500 })).toBe(1);
  });

  it('lets the last heading on screen win at the bottom of the page', () => {
    expect(activeHeadingIndex(tops, { ...page, scrollTop: 2400 })).toBe(4);
  });
});

describe('railTicks', () => {
  it('draws one stroke per heading on screen, with the depth below the top level', () => {
    const ticks = railTicks([entry(2), entry(3), entry(3, 'x'), entry(4), entry(2)]);
    expect(ticks).toEqual([
      { index: 0, depth: 0 },
      { index: 1, depth: 1 },
      { index: 3, depth: 2 },
      { index: 4, depth: 0 },
    ]);
  });

  it('drops the deepest level first when there are too many', () => {
    const entries = [entry(1), entry(2), entry(3), entry(3), entry(1), entry(2), entry(3)];
    expect(railTicks(entries, 4).map((tick) => tick.index)).toEqual([0, 1, 4, 5]);
  });

  it('thins a single level evenly once dropping levels is not enough', () => {
    const entries = Array.from({ length: 10 }, () => entry(2));
    expect(railTicks(entries, 5).map((tick) => tick.index)).toEqual([0, 2, 4, 6, 8]);
  });

  it('marks the stroke at or before the current heading', () => {
    const ticks = railTicks([entry(1), entry(1), entry(3), entry(1)], 3);
    // With room for three, the level-3 heading is dropped: its section shows as
    // the stroke before it.
    expect(activeTickIndex(ticks, 2)).toBe(1);
    expect(activeTickIndex(ticks, null)).toBeNull();
  });
});

describe('outlinePlacement', () => {
  it('pins only where the list fits beside the text', () => {
    expect(outlinePlacement(PINNED_WIDTH + 32, true)).toBe('pinned');
    expect(outlinePlacement(PINNED_WIDTH + 31, true)).toBe('rail');
    expect(outlinePlacement(PINNED_WIDTH + 100, false)).toBe('rail');
    expect(outlinePlacement(20, true)).toBe('compact');
  });
});

describe('outlineWanted', () => {
  const four = [entry(1), entry(2), entry(2), entry(2)];

  it('needs four headings and a page of one and a half screens', () => {
    expect(outlineWanted(four, { viewportHeight: 600, scrollHeight: 900 })).toBe(true);
    expect(outlineWanted(four, { viewportHeight: 600, scrollHeight: 899 })).toBe(false);
    expect(outlineWanted(four.slice(1), { viewportHeight: 600, scrollHeight: 5000 })).toBe(false);
  });
});
