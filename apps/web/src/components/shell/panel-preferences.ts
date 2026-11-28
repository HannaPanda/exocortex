/**
 * The two layout panels' persisted preferences.
 *
 * Their own module because the shell is no longer the only thing that sets
 * them: `/chats` opens the context panel on its way to a conversation
 * (issue #69), and a second copy of the key or of the fallback width would be
 * a second, quietly diverging default.
 */

export const SIDEBAR_STORAGE_KEY = 'exocortex.sidebar';
export const CONTEXT_STORAGE_KEY = 'exocortex.context';

export interface PanelPreference {
  open: boolean;
  width: number;
}

export const SIDEBAR_DEFAULT: PanelPreference = { open: true, width: 272 };
export const CONTEXT_DEFAULT: PanelPreference = { open: true, width: 336 };

export function parsePanelPreference(raw: string): PanelPreference {
  const parsed = JSON.parse(raw) as Partial<PanelPreference>;
  return {
    open: typeof parsed.open === 'boolean' ? parsed.open : true,
    width: typeof parsed.width === 'number' ? parsed.width : 272,
  };
}

/**
 * How wide the context panel may be (issue #246).
 *
 * It used to stop at 520 px whatever the window, so on a wide screen the
 * assistant stayed a strip beside a page with room to spare. Now its upper
 * limit is whatever the page beside it can give up: the page keeps
 * `CONTEXT_PAGE_KEEPS`, the narrowest editor worth reading (the 20rem
 * measure below which `globals.css` gives up the editor's gutter, plus that
 * gutter on both sides, 2 x 5.375rem, rounded up to whole rem). The lower
 * limit stays where narrow work put it (`CONTEXT_MIN_WIDTH`).
 *
 * The stored width is the reader's and is never rewritten by the limits:
 * a window made smaller, or a navigation dragged wider, draws the panel
 * narrower, and the remembered width comes back with the room. Where the
 * room is too small for both, the panel's minimum wins.
 */
export const CONTEXT_MIN_WIDTH = 260;
export const CONTEXT_PAGE_KEEPS = 496;

export interface ContextWidth {
  width: number;
  min: number;
  max: number;
}

/**
 * The width to draw for a stored `stored` in a row `roomWidth` pixels wide
 * (the shell's body less the navigation), and the handle's limits. A room
 * that is not measured yet (0) limits nothing but the minimum.
 */
export function resolveContextWidth(stored: number, roomWidth: number): ContextWidth {
  const min = CONTEXT_MIN_WIDTH;
  const wanted = Math.round(Math.max(min, stored));
  if (roomWidth <= 0) return { width: wanted, min, max: wanted };
  const max = Math.max(min, Math.round(roomWidth - CONTEXT_PAGE_KEEPS));
  return { width: Math.min(max, wanted), min, max };
}
