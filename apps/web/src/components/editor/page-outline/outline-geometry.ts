import { type PageOutlineEntry } from '@exocortex/editor';

/**
 * The arithmetic behind the floating outline (issue #194), kept free of the DOM
 * so it can be tested and so a scroll event costs a pass over cached numbers
 * rather than a layout read per heading.
 */

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

/** Distance of the outline from the top edge of the page area, in pixels (1.5rem). */
export const OUTLINE_TOP = 24;

/**
 * Where the top of the pinned list and the scale sit, in pixels from the top
 * of the page area (issue #266).
 *
 * The outline floats beside the scroll container, so it does not scroll; the
 * cover and the title above the text do. At the top of a page the outline
 * therefore starts where the content under the title starts (`contentTop`,
 * measured from the top of the scrolled content), rises with it while the
 * reader scrolls, and stays at `OUTLINE_TOP` from then on, the way it always
 * did. A page without a cover or with a short title barely moves it.
 */
export function outlineTop(contentTop: number, scrollTop: number): number {
  return Math.max(OUTLINE_TOP, Math.round(contentTop - scrollTop));
}

/** How the outline is offered, decided by the room beside the text column. */
export type OutlinePlacement = 'pinned' | 'rail' | 'compact';

/** Width of the pinned outline, in pixels (15rem): the header, its rule and its pin need it. */
export const PINNED_WIDTH = 240;
/** The lane the collapsed scale needs beside the text, in pixels (2.5rem). */
export const RAIL_LANE = 40;
/** Air kept between the text column and anything beside it, in pixels. */
export const OUTLINE_GAP = 16;
/**
 * The column a pinned outline takes from the page area, in pixels (16rem): the
 * list and the air on its inner side. The scroll container gives it up as
 * right padding (`--outline-lane`, globals.css), so the page, its gutter and
 * a database that breaks out of the measure are all laid out in what is left.
 */
export const PINNED_LANE = PINNED_WIDTH + OUTLINE_GAP;
/**
 * The narrowest page box that is still worth pinning beside, in pixels: the
 * 20rem measure globals.css calls the narrowest still worth reading, plus the
 * page's plain padding (1.5rem) on both sides.
 */
export const PINNED_MIN_PAGE = 368;

/**
 * Whether the outline can be pinned in a scroll area this wide (`room`, the
 * visible width beside the scrollbar). Pinning makes its own room by taking a
 * column off the page area (issue #267), so the page width (narrow, wide or
 * full) does not matter, only whether the text keeps a readable measure in
 * what is left. Asked of the area as a whole and never of the room the text
 * leaves free: that room grows once the column is taken, and an answer that
 * moved with it would switch the pin off and on again.
 */
export function canPinOutline(room: number): boolean {
  return room - PINNED_LANE >= PINNED_MIN_PAGE;
}

/**
 * `free` is the room between the right edge of the text and the right edge of
 * the visible scroll area, `room` the visible width of the scroll area. The
 * outline is never drawn over the text: a pinned list takes a column of its
 * own, the scale needs a lane in the margin, and where there is neither a
 * phone gets a compact button that floats like every other floating control.
 */
export function outlinePlacement(
  free: number,
  room: number,
  pinRequested: boolean,
): OutlinePlacement {
  if (pinRequested && canPinOutline(room)) return 'pinned';
  if (free >= RAIL_LANE) return 'rail';
  return 'compact';
}

/**
 * Whether the page gets the outline: as soon as it has a heading. It used to
 * wait for four headings and a page of one and a half screens, and a rule the
 * reader cannot see made the outline come and go for no visible reason, and
 * missed the long page with two headings that needs it most.
 */
export function outlineWanted(entries: readonly PageOutlineEntry[]): boolean {
  return entries.length > 0;
}
