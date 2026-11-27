import { describe, expect, it } from 'vitest';

import { type PageOutlineEntry } from '@exocortex/editor';

import {
  activeHeadingIndex,
  activeTickIndex,
  canPinOutline,
  DODGE_GAP,
  dodgeCaret,
  OUTLINE_TOP,
  outlinePlacement,
  outlineTop,
  outlineWanted,
  overlayCovers,
  PINNED_LANE,
  PINNED_MIN_PAGE,
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
  // Issue #267: a full-width page leaves no margin at all, and the pin used
  // to vanish with it. Pinning takes its own column, so the margin the text
  // happens to leave says nothing about whether it can be pinned.
  it('pins whatever the margin beside the text, wherever the area holds a column', () => {
    const room = PINNED_LANE + PINNED_MIN_PAGE;
    expect(outlinePlacement(0, room, true)).toBe('pinned');
    expect(outlinePlacement(400, room, true)).toBe('pinned');
    expect(outlinePlacement(400, room - 1, true)).toBe('rail');
  });

  it('offers the scale in a margin and a button where there is none', () => {
    expect(outlinePlacement(400, 2000, false)).toBe('rail');
    expect(outlinePlacement(40, 2000, false)).toBe('rail');
    expect(outlinePlacement(39, 2000, false)).toBe('compact');
    expect(outlinePlacement(20, 390, true)).toBe('compact');
  });
});

describe('canPinOutline', () => {
  it('keeps the narrowest readable page beside the pinned column', () => {
    expect(canPinOutline(PINNED_LANE + PINNED_MIN_PAGE)).toBe(true);
    expect(canPinOutline(PINNED_LANE + PINNED_MIN_PAGE - 1)).toBe(false);
    // A phone never pins; a tablet held upright does.
    expect(canPinOutline(390)).toBe(false);
    expect(canPinOutline(768)).toBe(true);
  });
});

describe('overlayCovers (issue #283)', () => {
  it('lies on text only where the margin is narrower than the column', () => {
    expect(overlayCovers(0)).toBe(true);
    expect(overlayCovers(PINNED_LANE - 1)).toBe(true);
    expect(overlayCovers(PINNED_LANE)).toBe(false);
    expect(overlayCovers(900)).toBe(false);
  });
});

describe('dodgeCaret (issue #283)', () => {
  const list = { top: 100, bottom: 400 };

  it('leaves the list alone while the line being written on is clear of it', () => {
    expect(dodgeCaret(list, { top: 420, bottom: 440 }, 876)).toBeNull();
    expect(dodgeCaret(list, { top: 60, bottom: 80 }, 876)).toBeNull();
  });

  it('steps below a line near its top, whole, where there is room', () => {
    expect(dodgeCaret(list, { top: 140, bottom: 160 }, 876)).toEqual({
      top: 160 + DODGE_GAP,
      maxHeight: 300,
    });
  });

  it('ends above a line near the bottom of the window, keeping its own top', () => {
    expect(dodgeCaret(list, { top: 380, bottom: 400 }, 500)).toEqual({
      top: 100,
      maxHeight: 380 - DODGE_GAP - 100,
    });
  });

  it('takes whichever way keeps more of it in view', () => {
    // Below the line there are 60px, above it 222px.
    const placed = dodgeCaret(list, { top: 330, bottom: 350 }, 418);
    expect(placed).toEqual({ top: 100, maxHeight: 222 });
  });

  it('counts the air around the line as part of it', () => {
    expect(dodgeCaret(list, { top: 404, bottom: 420 }, 876)).not.toBeNull();
    expect(dodgeCaret(list, { top: 400 + DODGE_GAP, bottom: 430 }, 876)).toBeNull();
  });
});

describe('outlineTop', () => {
  it('starts where the content under the cover and the title starts', () => {
    expect(outlineTop(420, 0)).toBe(420);
  });

  it('rises with the content and then stays at the top edge', () => {
    expect(outlineTop(420, 300)).toBe(120);
    expect(outlineTop(420, 396)).toBe(OUTLINE_TOP);
    expect(outlineTop(420, 2000)).toBe(OUTLINE_TOP);
  });

  it('never sits higher than the top edge on a page whose content starts above it', () => {
    expect(outlineTop(10, 0)).toBe(OUTLINE_TOP);
  });
});

describe('outlineWanted', () => {
  it('appears with the first heading, whatever the length of the page', () => {
    expect(outlineWanted([entry(2)])).toBe(true);
    expect(outlineWanted([])).toBe(false);
  });
});
