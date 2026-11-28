import { Extension } from '@tiptap/core';
import { type EditorState, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { type EditorView } from '@tiptap/pm/view';

/**
 * A short line in the left margin beside the block the caret is in (issue
 * #238).
 *
 * On a long page, or one of nested lists and tables, a one-pixel caret is easy
 * to lose. The line answers "where am I writing" from the margin, where the
 * eye can find it without reading.
 *
 * Which block: the innermost text block the caret stands in, so in a list it
 * is the point being written, in a table the cell's paragraph, in a quote or a
 * callout the paragraph inside it, and a code block as a whole. Anything that
 * is not a text caret marks nothing: a selected picture or divider already
 * shows its own frame, a selection of table cells tints the cells, and Strg+A
 * over the page is not a place.
 *
 * Where: always the same distance left of the text column, however deep the
 * block is nested, in the space between the heading's disclosure lane and the
 * block handle (`globals.css`). That is a fixed `left`; only `top` and
 * `height` are measured here.
 *
 * How it is drawn: one element in the editor's positioned parent, the way the
 * drop line of a dragged block is (`block-drop.ts`). Not a decoration on the
 * block: a class there would have to make every kind of block a positioned
 * box, and the pseudo-elements a paragraph has are already the line's hint
 * (`line-placeholder.ts`) and a list's markers. The element is absolutely
 * positioned, so it moves no text and changes no width.
 *
 * When: only while the editor has the focus and the reader is writing, so it
 * disappears with the caret when the focus goes elsewhere and is never there
 * on a page that is only read. A reader can switch it off
 * (`activeBlockMarker`, fed in through `setActiveBlockMarkerEnabled`).
 */
export const activeBlockMarkerKey = new PluginKey<ActiveBlockMarkerState>('activeBlockMarker');

interface ActiveBlockMarkerState {
  enabled: boolean;
}

/** The class the line carries; `globals.css` draws it. */
export const ACTIVE_BLOCK_MARKER_CLASS = 'exocortex-active-block-marker';

/**
 * Where the text block the caret is in starts, or `null` when nothing is to
 * be marked: no text caret, or a caret outside any text block.
 */
export function activeTextblockPos(state: EditorState): number | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $head } = selection;
  if ($head.depth === 0 || !$head.parent.isTextblock) return null;
  return $head.before();
}

export interface MarkerBox {
  top: number;
  height: number;
}

/**
 * The line's box, in the coordinates of the positioned parent it is drawn
 * into: from the block's top to its bottom. `origin` is the parent's own top
 * in client pixels, less its scroll offset. Rounded, so a block that did not
 * move gives the same box and nothing is written.
 */
export function markerBox(block: { top: number; bottom: number }, origin: number): MarkerBox {
  return {
    top: Math.round(block.top - origin),
    height: Math.max(0, Math.round(block.bottom - block.top)),
  };
}

/** Switches the line on or off for this editor, without rebuilding it. */
export function setActiveBlockMarkerEnabled(view: EditorView, enabled: boolean): void {
  if (view.isDestroyed) return;
  if (activeBlockMarkerKey.getState(view.state)?.enabled === enabled) return;
  view.dispatch(view.state.tr.setMeta(activeBlockMarkerKey, { enabled }));
}

class ActiveBlockMarkerView {
  private line: HTMLElement | null = null;
  private frame: number | null = null;
  private focused: boolean;
  private readonly resize: ResizeObserver | null;

  private readonly onFocus = (): void => {
    this.focused = true;
    this.schedule();
  };

  private readonly onBlur = (): void => {
    this.focused = false;
    this.schedule();
  };

  constructor(private readonly view: EditorView) {
    this.focused = view.hasFocus();
    view.dom.addEventListener('focus', this.onFocus);
    view.dom.addEventListener('blur', this.onBlur);
    // Text that rewraps (a narrower window, a picture above that loaded, a
    // pinned outline taking its column) moves the block without a
    // transaction; the editor's own size changes with it.
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.schedule);
    this.resize?.observe(view.dom);
    this.schedule();
  }

  update(): void {
    this.schedule();
  }

  destroy(): void {
    this.view.dom.removeEventListener('focus', this.onFocus);
    this.view.dom.removeEventListener('blur', this.onBlur);
    this.resize?.disconnect();
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.line?.remove();
    this.line = null;
  }

  /** Measures once per frame at most, after the DOM has caught up. */
  private readonly schedule = (): void => {
    if (this.frame === null) this.frame = window.requestAnimationFrame(this.draw);
  };

  private readonly draw = (): void => {
    this.frame = null;
    const box = this.view.isDestroyed ? null : this.measure();
    if (box === null) {
      this.line?.setAttribute('data-visible', 'false');
      return;
    }
    const line = this.ensureLine();
    if (line === null) return;
    const top = `${String(box.top)}px`;
    const height = `${String(box.height)}px`;
    if (line.style.top !== top) line.style.top = top;
    if (line.style.height !== height) line.style.height = height;
    line.setAttribute('data-visible', 'true');
  };

  private measure(): MarkerBox | null {
    const { view } = this;
    if (!view.editable || !this.focused) return null;
    if (activeBlockMarkerKey.getState(view.state)?.enabled === false) return null;
    const pos = activeTextblockPos(view.state);
    if (pos === null) return null;
    const block = view.nodeDOM(pos);
    const parent = view.dom.offsetParent;
    if (!(block instanceof HTMLElement) || !(parent instanceof HTMLElement)) return null;
    const rect = block.getBoundingClientRect();
    // A block that is not laid out (inside a collapsed section) has no place.
    if (rect.height === 0) return null;
    const parentRect = parent.getBoundingClientRect();
    return markerBox(rect, parentRect.top - parent.scrollTop);
  }

  private ensureLine(): HTMLElement | null {
    const parent = this.view.dom.offsetParent;
    if (!(parent instanceof HTMLElement)) return null;
    if (this.line?.parentElement === parent) return this.line;
    this.line?.remove();
    const line = parent.ownerDocument.createElement('div');
    line.className = ACTIVE_BLOCK_MARKER_CLASS;
    line.setAttribute('aria-hidden', 'true');
    line.dataset.testid = 'active-block-marker';
    line.dataset.visible = 'false';
    parent.appendChild(line);
    this.line = line;
    return line;
  }
}

export const ActiveBlockMarker = Extension.create({
  name: 'activeBlockMarker',

  addProseMirrorPlugins() {
    return [
      new Plugin<ActiveBlockMarkerState>({
        key: activeBlockMarkerKey,
        state: {
          init: () => ({ enabled: true }),
          apply: (tr, value) =>
            (tr.getMeta(activeBlockMarkerKey) as ActiveBlockMarkerState | undefined) ?? value,
        },
        view: (view) => new ActiveBlockMarkerView(view),
      }),
    ];
  },
});
