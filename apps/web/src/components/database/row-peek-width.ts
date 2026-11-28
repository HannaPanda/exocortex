/**
 * How wide the side panel a row opens in is (issue #239).
 *
 * Without a width of its own the panel is about half the page area, between
 * 26 and 44 rem, which is what it was before it could be dragged. A dragged
 * width is the reader's and is kept in this browser, like the widths of the
 * navigation and the context panel (`panel-preferences.ts`). Resetting forgets
 * it, so the panel follows the page area again instead of freezing at the
 * default of the window it was reset in.
 *
 * Two limits hold whatever was stored, because the page area changes under a
 * stored width (a smaller window, the context panel opened):
 *
 * - `ROW_PEEK_MIN_WIDTH` keeps a property's name and its value side by side
 *   in the row header and leaves the editor a line worth reading.
 * - `ROW_PEEK_TABLE_KEEPS` is what the table keeps visible to the left of the
 *   panel: enough of the name column to see which row is which and to click
 *   the next one.
 *
 * Where the page area is too narrow for both, the minimum wins and the panel
 * covers the area, which is the phone's case and is never dragged there.
 */

export const ROW_PEEK_STORAGE_KEY = 'exocortex.rowPeek';

export const ROW_PEEK_MIN_WIDTH = 360;
export const ROW_PEEK_TABLE_KEEPS = 240;

const DEFAULT_MIN = 416; // 26rem
const DEFAULT_MAX = 704; // 44rem
const DEFAULT_SHARE = 0.48;

export interface RowPeekWidthPreference {
  /** Pixels, or `null` for the default that follows the page area. */
  width: number | null;
}

export const ROW_PEEK_WIDTH_DEFAULT: RowPeekWidthPreference = { width: null };

export function parseRowPeekWidth(raw: string): RowPeekWidthPreference {
  const parsed = JSON.parse(raw) as Partial<RowPeekWidthPreference> | null;
  const width = parsed?.width;
  return {
    width: typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null,
  };
}

export interface RowPeekWidth {
  width: number;
  min: number;
  max: number;
}

/** The width to draw in a page area `areaWidth` pixels wide, and its limits. */
export function resolveRowPeekWidth(stored: number | null, areaWidth: number): RowPeekWidth {
  const min = ROW_PEEK_MIN_WIDTH;
  const max = Math.max(min, Math.round(areaWidth - ROW_PEEK_TABLE_KEEPS));
  const wanted =
    stored ?? Math.min(DEFAULT_MAX, Math.max(DEFAULT_MIN, Math.round(areaWidth * DEFAULT_SHARE)));
  return { width: Math.round(Math.min(max, Math.max(min, wanted))), min, max };
}
