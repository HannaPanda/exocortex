import { type PageOutlineEntry } from '@exocortex/editor';

/**
 * The arithmetic behind the floating outline (issue #194), kept free of the DOM
 * so it can be tested and so a scroll event costs a pass over cached numbers
 * rather than a layout read per heading.
 */

/** A page needs at least this many headings before the outline appears. */
export const OUTLINE_MIN_HEADINGS = 4;
/** And has to be at least this many screens long: a short page is read whole. */
export const OUTLINE_MIN_SCREENS = 1.5;

export interface ScrollMetrics {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}

/**
 * The reading line: a heading that has risen past it opens the section being
 * read. A third of the screen, capped, so a tall window does not switch to a
 * section whose first line is still far below the eye.
 */
export function readingLine(viewportHeight: number): number {
  return Math.min(viewportHeight * 0.3, 180);
}

/**
 * Which heading's section is being read, as an index into `tops`.
 *
 * `tops` holds each heading's offset from the top of the scrolled content, or
 * `null` for a heading that is not drawn (inside a collapsed section). The
 * answer only changes when a heading crosses the reading line, so it does not
 * flicker between two sections at a boundary. At the very bottom of the page
 * the last heading that is on screen wins, otherwise a short final section
 * could never become current. Above the first heading there is none: `null`.
 */
export function activeHeadingIndex(
  tops: readonly (number | null)[],
  metrics: ScrollMetrics,
): number | null {
  const { scrollTop, viewportHeight, scrollHeight } = metrics;
  const atBottom = scrollTop + viewportHeight >= scrollHeight - 2;
  const line = atBottom ? scrollTop + viewportHeight - 1 : scrollTop + readingLine(viewportHeight);
  for (let index = tops.length - 1; index >= 0; index -= 1) {
    const top = tops[index];
    if (top !== null && top !== undefined && top <= line) return index;
  }
  return null;
}

/** One stroke of the collapsed scale. */
export interface RailTick {
  /** Index into the outline. */
  index: number;
  /** 0 for the page's top heading level, 1 for the next, and so on. */
  depth: number;
}

/** More strokes than this stop reading as a scale and start reading as a bar. */
export const RAIL_MAX_TICKS = 32;

/**
 * The strokes of the collapsed scale: one per heading that is on screen.
 *
 * A page with more headings than fit drops its deepest level first, so the
 * scale keeps the page's structure rather than an arbitrary sample of it; only
 * when a single level is still too many is it thinned evenly.
 */
export function railTicks(
  entries: readonly PageOutlineEntry[],
  max: number = RAIL_MAX_TICKS,
): RailTick[] {
  const visible = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.hiddenUnder === null);
  if (visible.length === 0) return [];
  const levels = [...new Set(visible.map(({ entry }) => entry.level))].sort((a, b) => a - b);

  let kept = visible;
  for (let deepest = levels.length - 1; kept.length > max && deepest > 0; deepest -= 1) {
    const cutoff = levels[deepest - 1] as number;
    kept = visible.filter(({ entry }) => entry.level <= cutoff);
  }
  if (kept.length > max) {
    const step = kept.length / max;
    kept = Array.from(
      { length: max },
      (_, slot) => kept[Math.floor(slot * step)] as (typeof kept)[0],
    );
  }
  return kept.map(({ entry, index }) => ({
    index,
    depth: levels.indexOf(entry.level),
  }));
}

/** The stroke that stands for the current section: the last one at or before it. */
export function activeTickIndex(ticks: readonly RailTick[], active: number | null): number | null {
  if (active === null) return null;
  for (let position = ticks.length - 1; position >= 0; position -= 1) {
    if ((ticks[position] as RailTick).index <= active) return position;
  }
  return null;
}

/** How the outline is offered, decided by the room beside the text column. */
export type OutlinePlacement = 'pinned' | 'rail' | 'compact';

/** Width of the pinned outline, in pixels (14rem): the header and its pin need it. */
export const PINNED_WIDTH = 224;
/** The lane the collapsed scale needs beside the text, in pixels (2.5rem). */
export const RAIL_LANE = 40;
/** Air kept between the text column and anything beside it, in pixels. */
export const OUTLINE_GAP = 16;

/**
 * `free` is the room between the right edge of the text and the right edge of
 * the visible scroll area. The outline is only ever drawn into room that is
 * there: a pinned list over the text would be the permanent overlay the issue
 * rules out, so a narrow window falls back to the scale, and a phone to a
 * compact button that floats like every other floating control.
 */
export function outlinePlacement(free: number, pinRequested: boolean): OutlinePlacement {
  if (pinRequested && free >= PINNED_WIDTH + 2 * OUTLINE_GAP) return 'pinned';
  if (free >= RAIL_LANE) return 'rail';
  return 'compact';
}

/** Whether the page is long and structured enough to deserve the outline. */
export function outlineWanted(
  entries: readonly PageOutlineEntry[],
  metrics: Pick<ScrollMetrics, 'viewportHeight' | 'scrollHeight'>,
): boolean {
  return (
    entries.length >= OUTLINE_MIN_HEADINGS &&
    metrics.scrollHeight >= metrics.viewportHeight * OUTLINE_MIN_SCREENS
  );
}
