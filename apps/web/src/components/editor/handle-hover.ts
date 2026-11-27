import { type DragHandleProps } from '@tiptap/extension-drag-handle-react';
import { type EditorView } from '@tiptap/pm/view';

/**
 * Which block the handle belongs to while the pointer moves (issue #286).
 *
 * The drag-handle plugin asks, on every frame the pointer moves, which block
 * sits under it, and lets rules veto candidates. Its own edge detection vetoed
 * a nested block whenever the pointer was within 12 px of that block's left
 * edge, *including* the first 12 px of its text and everything left of it. A
 * nested list item's handle stands left of the item, in the indentation of
 * the item above, so the way from the text to the handle ran through exactly
 * that zone: the handle jumped to the parent item before the pointer arrived,
 * and a sub-item could not be reached at all. A paragraph in a quote lost its
 * handle to the quote the same way.
 *
 * Two rules replace the edge detection:
 *
 * - `LEFT_OF_BLOCK`: a block inside a container (a quote, a callout, a column,
 *   a table cell, a list item's second block) gives way to its container only
 *   while the pointer is left of the block, in the container's own margin.
 *   Over the block's text it is always the block. List items never give way
 *   to the item around them: a list cannot be grabbed as a whole, and the
 *   indentation in front of a sub-item belongs to the sub-item's line.
 * - `HANDLE_CORRIDOR`: once the handle stands beside a block, the strip
 *   between that block's own line and the handle belongs to it. Every other
 *   candidate is vetoed there, and with every candidate vetoed the plugin
 *   leaves the handle where it is. That is the continuous way from the line to
 *   the button the issue asks for, whatever the plugin would find under the
 *   pointer on the way.
 *
 * Rules see no coordinates, so the pointer is recorded here per view, from the
 * same `mousemove` the plugin reacts to; the plugin evaluates the rules one
 * animation frame later, when the latest position is already stored.
 */

type NestedOptions = Exclude<DragHandleProps['nested'], boolean | undefined>;
/** The plugin's rule type, reached through the React package's own props. */
export type HandleRule = NonNullable<NestedOptions['rules']>[number];
type RuleContext = Parameters<HandleRule['evaluate']>[0];

/** A rule's veto: the plugin drops a candidate whose score reaches zero. */
const VETO = 1000;

/** Node types that are items of a list. */
const LIST_ITEM_TYPES: ReadonlySet<string> = new Set(['listItem', 'taskItem']);

export interface Point {
  x: number;
  y: number;
}

/** The part of a `DOMRect` these decisions read. */
export interface Box {
  left: number;
  top: number;
  bottom: number;
}

/**
 * True while the pointer is in the strip between a block and its handle.
 *
 * `line` is the block's own line: the whole block, except for a list item,
 * whose sub-items have lines (and handles) of their own. Horizontally the strip
 * runs from the handle's left edge to where the block starts; over the block
 * itself the ordinary decision already finds it, or a block inside it.
 */
export function inHandleCorridor(pointer: Point, block: Box, line: Box, handle: Box): boolean {
  return (
    pointer.y >= block.top &&
    pointer.y <= line.bottom &&
    pointer.x >= handle.left &&
    pointer.x < block.left
  );
}

interface HoverState {
  /** Where the pointer last moved over the editor, in client coordinates. */
  pointer: Point | null;
  /** The block the handle stands beside, by position; `null` while it is hidden. */
  target: number | null;
  /** The plugin's handle element. */
  handle: HTMLElement | null;
}

const states = new WeakMap<EditorView, HoverState>();

function stateOf(view: EditorView): HoverState {
  let state = states.get(view);
  if (state === undefined) {
    state = { pointer: null, target: null, handle: null };
    states.set(view, state);
  }
  return state;
}

/**
 * Starts recording the pointer over `view` for the rules below, and tells them
 * which element is the handle. Returns the function that stops it.
 */
export function trackHandleHover(view: EditorView, handle: HTMLElement): () => void {
  const state = stateOf(view);
  state.handle = handle;
  const record = (event: MouseEvent): void => {
    state.pointer = { x: event.clientX, y: event.clientY };
  };
  view.dom.addEventListener('mousemove', record, { passive: true });
  return () => {
    view.dom.removeEventListener('mousemove', record);
    states.delete(view);
  };
}

/** Tells the rules which block the handle now stands beside. */
export function noteHandleTarget(view: EditorView, pos: number | null): void {
  stateOf(view).target = pos;
}

function elementAt(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * Vetoes a block inside a container while the pointer is left of it, so the
 * container takes the handle there; never a list item (see the module comment).
 */
const leftOfBlock: HandleRule = {
  id: 'exocortexLeftOfBlock',
  evaluate: ({ node, pos, depth, view }: RuleContext): number => {
    if (depth < 2 || LIST_ITEM_TYPES.has(node.type.name)) return 0;
    const pointer = states.get(view)?.pointer;
    if (pointer === null || pointer === undefined) return 0;
    const dom = elementAt(view, pos);
    if (dom === null) return 0;
    return pointer.x < dom.getBoundingClientRect().left ? VETO : 0;
  },
};

/** The bottom of a block's own line, as `inHandleCorridor` reads it. */
function lineBox(view: EditorView, pos: number, block: DOMRect): Box {
  const node = view.state.doc.nodeAt(pos);
  if (node === null || !LIST_ITEM_TYPES.has(node.type.name) || node.childCount < 2) return block;
  // The item's first child is its own text; what follows are its sub-items.
  const first = elementAt(view, pos + 1);
  return first === null ? block : first.getBoundingClientRect();
}

/**
 * Vetoes every block but the handle's own while the pointer travels from that
 * block to the handle; see `inHandleCorridor`.
 */
const handleCorridor: HandleRule = {
  id: 'exocortexHandleCorridor',
  evaluate: ({ pos, view }: RuleContext): number => {
    const state = states.get(view);
    if (state === undefined) return 0;
    const { pointer, target, handle } = state;
    if (pointer === null || target === null || handle === null || pos === target) return 0;
    // A hidden handle is no destination; the plugin hides it after a drag
    // without saying so.
    if (handle.style.visibility === 'hidden') return 0;
    const dom = elementAt(view, target);
    if (dom === null) return 0;
    const block = dom.getBoundingClientRect();
    const inside = inHandleCorridor(
      pointer,
      block,
      lineBox(view, target, block),
      handle.getBoundingClientRect(),
    );
    return inside ? VETO : 0;
  },
};

/**
 * Which block the handle belongs to when blocks are nested, as `DragHandle`'s
 * `nested` option.
 *
 * The plugin's default rules stay: a list item's first block is the item, a
 * list as a whole is never a target, nor are table rows and cells. Its edge
 * detection is off; `leftOfBlock` takes its place. Before issue #286 the left
 * edge alone was kept (issue #243), because the default also preferred the
 * outer block near the top edge, which excluded a list's first and last item.
 *
 * A module constant: `DragHandle` normalises it inside an effect dependency
 * (docs/deviations.md 17).
 */
export const NESTED_TARGETS: NestedOptions = {
  edgeDetection: 'none',
  rules: [leftOfBlock, handleCorridor],
};
