import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { type EditorView } from '@tiptap/pm/view';

/**
 * Room below the line being written in (issue #281).
 *
 * Two halves, and neither stores anything:
 *
 * - **Space past the end.** `globals.css` gives the page's own editor, while
 *   it is being written in, about half a screen of padding below its last
 *   block, so the last line can be scrolled up to the middle of the page
 *   instead of sitting on the bottom edge. It is padding on the editor's own
 *   surface, so a click into it is a click below the last block and opens the
 *   line `TrailingParagraph` draws there (issue #257); it is gone on a page
 *   that is only read and in print.
 * - **Following the caret.** ProseMirror scrolls the caret into view after
 *   every keystroke, but only as far as five pixels from the edge, so typing
 *   on the last line of a long page stays glued to the bottom. Its own props
 *   do the rest: `scrollThreshold` says from how near the bottom edge the view
 *   moves, `scrollMargin` how far up the caret then goes. No scroll code of
 *   our own; the space past the end is what gives the view room to move.
 *
 * The bottom value is read at the moment ProseMirror scrolls, through a
 * getter, because it depends on what is visible right then: on a phone the
 * on-screen keyboard covers the bottom of the page without making the scroll
 * container any shorter (only the visual viewport shrinks), so the part it
 * covers is added to the margin. Without that a new line made with `Enter`
 * would be scrolled into view behind the keyboard.
 */
export const writingRoomKey = new PluginKey('writingRoom');

/** How much of the visible page stays below the caret while writing. */
const COMFORT_SHARE = 0.25;
/** At least two lines of air, and on a tall screen never more than this. */
const COMFORT_MIN_PX = 48;
const COMFORT_MAX_PX = 200;
/** ProseMirror's own default for the other three sides. */
const DEFAULT_MARGIN_PX = 5;

export interface VerticalSpan {
  top: number;
  bottom: number;
}

/**
 * How far above the bottom edge of the scroll container the caret is kept:
 * the part of the container the visual viewport does not show (the on-screen
 * keyboard), plus a share of what it does show. All values in client pixels.
 */
export function bottomRoom(scroller: VerticalSpan, visual: VerticalSpan): number {
  const visibleBottom = Math.min(scroller.bottom, visual.bottom);
  const visibleTop = Math.max(scroller.top, visual.top);
  const covered = Math.max(0, scroller.bottom - visibleBottom);
  const visible = Math.max(0, visibleBottom - visibleTop);
  const comfort = Math.min(COMFORT_MAX_PX, Math.max(COMFORT_MIN_PX, visible * COMFORT_SHARE));
  // Never more than half of what is visible: with nothing left to show the
  // caret in, ProseMirror would scroll it above the top edge instead. And
  // never less than ProseMirror's own default.
  return Math.round(
    Math.max(DEFAULT_MARGIN_PX, Math.min(covered + comfort, covered + visible / 2)),
  );
}

function measuredRoom(view: EditorView): number {
  if (view.isDestroyed) return DEFAULT_MARGIN_PX;
  const scroller = view.dom.closest<HTMLElement>('.exocortex-page-scroll');
  if (scroller === null) return DEFAULT_MARGIN_PX;
  const rect = scroller.getBoundingClientRect();
  // Absent rather than null where it is not implemented (jsdom among them).
  const viewport = window.visualViewport;
  const visual =
    viewport == null
      ? { top: 0, bottom: window.innerHeight }
      : { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height };
  return bottomRoom({ top: rect.top, bottom: rect.bottom }, visual);
}

export const WritingRoom = Extension.create({
  name: 'writingRoom',

  addProseMirrorPlugins() {
    // The plugin keeps a reference to these objects, and ProseMirror reads a
    // side by name each time it scrolls, so the getters answer for the layout
    // of that moment. Only the bottom side changes; the rest stays default.
    let view: EditorView | null = null;
    const bottom = (): number => (view === null ? DEFAULT_MARGIN_PX : measuredRoom(view));
    const scrollMargin = {
      top: DEFAULT_MARGIN_PX,
      left: DEFAULT_MARGIN_PX,
      right: DEFAULT_MARGIN_PX,
      get bottom(): number {
        return bottom();
      },
    };
    const scrollThreshold = {
      top: 0,
      left: 0,
      right: 0,
      get bottom(): number {
        return bottom();
      },
    };
    return [
      new Plugin({
        key: writingRoomKey,
        view: (editorView) => {
          view = editorView;
          return {
            destroy: () => {
              view = null;
            },
          };
        },
        props: { scrollMargin, scrollThreshold },
      }),
    ];
  },
});
