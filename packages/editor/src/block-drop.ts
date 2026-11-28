import { Extension } from '@tiptap/core';
import {
  Fragment,
  type Node as PmNode,
  type NodeType,
  type ResolvedPos,
  Slice,
} from '@tiptap/pm/model';
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

import { isListNode, LIST_ITEM_TYPE_NAMES, splitListAt } from './list-split';
import { fitsTableCellRule } from './table-cell-blocks';

/**
 * Dragging a block with a line that says where it lands (issue #243).
 *
 * ProseMirror on its own drops a dragged block wherever `dropPoint` finds room
 * near the pointer, and draws nothing while it does: a person could not tell
 * that a drag was under way, let alone whether the list item they held would
 * end up as the next item, as a sub-item, or below the list. This module
 * decides the place itself and draws it, the way an outliner does:
 *
 * - The pointer's height picks a gap between two blocks.
 * - A gap between two blocks is several places at once when lists or other
 *   containers close there: the end of a sub-list, the end of the item
 *   holding it, the end of the list, the page below. Every place where the
 *   dragged content fits is a candidate (`blockDropCandidates`).
 * - The pointer's horizontal position picks one of them. The block follows the
 *   pointer sideways as if it were being carried, so moving right by one
 *   indentation nests it one level deeper and moving left lifts it out.
 * - The line starts where the dropped block's text will start and runs to the
 *   right edge of its container, so its length and indentation name the level.
 *
 * A list item dropped where only a block fits (inside an item, below a list)
 * gets a list of its own kind around it, which is what makes a sub-item. The
 * move is one transaction, so `Strg+Z` takes it back in one step, and a block
 * that fits nowhere at the pointer shows no line and is not dropped at all:
 * nothing lands somewhere the line did not promise.
 *
 * Only whole blocks are handled here. Dragging selected text keeps
 * ProseMirror's own behaviour.
 */

/** Where the dragged blocks stand in the document before the drop. */
export interface BlockDropSource {
  from: number;
  to: number;
}

/** One place a dragged block can land. */
export interface BlockDropCandidate {
  /** A position between blocks, in the document before the drop. */
  pos: number;
  /**
   * A list type to wrap the dropped list items in, or `null` when the content
   * fits as it is. Set where a list item lands among blocks: that is a new
   * sub-list, or a list of its own below the old one.
   */
  wrap: NodeType | null;
  /**
   * The place is between two items of a list the content does not fit in (a
   * paragraph, a heading, a picture): the list is split there and the content
   * stands between the two halves, at the list's own level.
   */
  split?: boolean;
}

/** The structure between two neighbouring blocks, as document positions. */
export interface BlockDropGap {
  /** The end of the block above the gap (or 0 at the top of the page). */
  from: number;
  /** The start of the block below the gap (or the end of the page). */
  to: number;
}

/**
 * The blocks a drop is aimed between: text blocks, and the blocks the pointer
 * cannot enter (an image, a formula, an embed, a divider, a whole table).
 * Anything else is a container whose children are aimed at instead.
 */
export function isDropLeaf(node: PmNode): boolean {
  if (!node.isBlock) return false;
  if (node.isTextblock || node.isAtom || node.isLeaf) return true;
  return node.type.spec.tableRole === 'table';
}

/**
 * The dragged range, when what is being dragged is a run of whole blocks.
 *
 * The drag handle and ProseMirror both put the dragged node on
 * `view.dragging.node`; a run of several blocks is the selection instead. A
 * slice that is open on either side is part of a paragraph, and dragging text
 * stays ProseMirror's business.
 */
export function blockDropSource(
  state: EditorState,
  slice: Slice,
  node: NodeSelection | undefined,
): BlockDropSource | null {
  if (slice.openStart !== 0 || slice.openEnd !== 0 || slice.content.childCount === 0) return null;
  let blocks = true;
  slice.content.forEach((child) => {
    if (!child.isBlock) blocks = false;
  });
  if (!blocks) return null;
  if (node !== undefined) return { from: node.from, to: node.to };
  const { selection } = state;
  if (selection.empty || !selection.$from.sameParent(selection.$to)) return null;
  if (selection.to - selection.from !== slice.content.size) return null;
  if (selection.$from.parent.inlineContent) return null;
  return { from: selection.from, to: selection.to };
}

/**
 * The list the dragged items came from, which is the kind a new sub-list of
 * them is made of: a numbered item stays numbered when it moves under another.
 */
export function dropWrapType(
  doc: PmNode,
  source: BlockDropSource,
  content: Fragment,
): NodeType | null {
  let items = content.childCount > 0;
  content.forEach((child) => {
    if (!LIST_ITEM_TYPE_NAMES.has(child.type.name)) items = false;
  });
  if (!items) return null;
  const parent = doc.resolve(source.from).parent;
  if (parent.type.validContent(content)) return parent.type;
  // Dragged from somewhere that is not a list (cannot happen through the
  // handle): the first list type of the schema that takes these items.
  for (const type of Object.values(doc.type.schema.nodes)) {
    if (type.isBlock && !type.isTextblock && type.validContent(content)) return type;
  }
  return null;
}

/** The position of the first drop leaf that starts at or after `pos`. */
function nextLeafStart(doc: PmNode, pos: number): number | null {
  let found: number | null = null;
  doc.nodesBetween(pos, doc.content.size, (node, nodePos) => {
    if (found !== null) return false;
    if (nodePos < pos) return true;
    if (isDropLeaf(node)) {
      found = nodePos;
      return false;
    }
    return true;
  });
  return found;
}

/** The end of the last drop leaf that ends at or before `pos`. */
function previousLeafEnd(doc: PmNode, pos: number): number | null {
  let found: number | null = null;
  doc.nodesBetween(0, pos, (node, nodePos) => {
    if (nodePos + node.nodeSize <= pos && isDropLeaf(node)) {
      found = nodePos + node.nodeSize;
      return false;
    }
    return !isDropLeaf(node);
  });
  return found;
}

/**
 * The drop leaf at a position ProseMirror found under the pointer: the text
 * block around it, the opaque block it points into, or the whole table it is
 * inside.
 */
export function dropLeafAt(doc: PmNode, pos: number, inside: number): number | null {
  const $pos = doc.resolve(pos);
  // The outermost table counts as one block: nobody drops a paragraph into a
  // cell by accident.
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.spec.tableRole === 'table') return $pos.before(depth);
  }
  if ($pos.parent.isTextblock && $pos.depth > 0) return $pos.before();
  if (inside >= 0) {
    const node = doc.nodeAt(inside);
    if (node !== null && isDropLeaf(node)) return inside;
  }
  const after = $pos.nodeAfter;
  if (after !== null && isDropLeaf(after)) return pos;
  const before = $pos.nodeBefore;
  if (before !== null && isDropLeaf(before)) return pos - before.nodeSize;
  const next = nextLeafStart(doc, pos);
  if (next !== null) return next;
  const end = previousLeafEnd(doc, pos);
  if (end === null) return null;
  const $end = doc.resolve(end);
  return end - ($end.nodeBefore?.nodeSize ?? 0);
}

/** The gap above (`after === false`) or below a drop leaf. */
export function dropGap(doc: PmNode, leafPos: number, after: boolean): BlockDropGap {
  const leaf = doc.nodeAt(leafPos);
  if (after) {
    const from = leafPos + (leaf?.nodeSize ?? 0);
    return { from, to: nextLeafStart(doc, from) ?? doc.content.size };
  }
  return { from: previousLeafEnd(doc, leafPos) ?? 0, to: leafPos };
}

/** Whether `$pos` is the place in front of a list item's own text. */
function inFrontOfItemText($pos: ResolvedPos): boolean {
  return LIST_ITEM_TYPE_NAMES.has($pos.parent.type.name) && $pos.index() === 0;
}

/**
 * Every place in a gap where `content` fits, in document order.
 *
 * Between the end of one block and the start of the next there are only the
 * boundaries of the containers that close and open there, so every position
 * in the gap is a candidate level. Excluded are the places inside the dragged
 * blocks themselves and the place in front of a list item's own text, which
 * would make the dropped block that item's first line.
 *
 * Between two items of a list, content that is no item of that list (a
 * paragraph, a heading, an item of another kind of list) can still land: the
 * list is split there (`split`), as long as the content fits where the list
 * itself stands.
 */
export function blockDropCandidates(
  doc: PmNode,
  gap: BlockDropGap,
  content: Fragment,
  source: BlockDropSource,
  wrap: NodeType | null,
): BlockDropCandidate[] {
  const candidates: BlockDropCandidate[] = [];
  const wrapped = wrap === null ? null : Fragment.from(wrap.create(null, content));
  for (let pos = gap.from; pos <= gap.to; pos += 1) {
    if (pos > source.from && pos < source.to) continue;
    const $pos = doc.resolve(pos);
    if ($pos.parent.inlineContent || inFrontOfItemText($pos)) continue;
    // No database lands in a table cell, not even inside a quote in one: the
    // schema only says so for the cell's own children (issue #312).
    if (!fitsTableCellRule($pos, content)) continue;
    const index = $pos.index();
    if ($pos.parent.canReplace(index, index, content)) {
      candidates.push({ pos, wrap: null });
    } else if (wrapped !== null && $pos.parent.canReplace(index, index, wrapped)) {
      candidates.push({ pos, wrap });
    } else if (fitsSplit($pos, content)) {
      candidates.push({ pos, wrap: null, split: true });
    } else if (wrapped !== null && fitsSplit($pos, wrapped)) {
      candidates.push({ pos, wrap, split: true });
    }
  }
  return candidates;
}

/**
 * Whether `content` can stand between the two halves of the list `$pos` is
 * in, were the list split at `$pos`. Only a place strictly between two items
 * splits: at either end of the list the place before or after it is in the
 * same gap already.
 */
function fitsSplit($pos: ResolvedPos, content: Fragment): boolean {
  const list = $pos.parent;
  if ($pos.depth === 0 || !isListNode(list)) return false;
  const index = $pos.index();
  if (index === 0 || index >= list.childCount) return false;
  const halves = Fragment.from(list).append(content).append(Fragment.from(list));
  const listIndex = $pos.index(-1);
  return $pos.node(-1).canReplace(listIndex, listIndex + 1, halves);
}

/**
 * The drop as one transaction, or `null` when it would change nothing (the
 * blocks dropped where they already are) or cannot be made.
 *
 * The old blocks go first, with `deleteRange`, so a sub-list whose only item
 * left does not stay behind as an empty shell; the new place is then mapped
 * through that deletion. The dropped block ends up selected, as it is after
 * ProseMirror's own drop.
 */
export function blockDropTransaction(
  state: EditorState,
  source: BlockDropSource,
  candidate: BlockDropCandidate,
  content: Fragment,
  move: boolean,
): Transaction | null {
  if (
    move &&
    candidate.wrap === null &&
    candidate.split !== true &&
    (candidate.pos === source.from || candidate.pos === source.to)
  ) {
    return null;
  }
  const tr = state.tr;
  if (move) tr.deleteRange(source.from, source.to);
  const mapped = tr.mapping.mapResult(candidate.pos);
  if (mapped.deletedAcross) return null;
  // Between two items: the list becomes two, and the block goes between them.
  const at = candidate.split === true ? splitListAt(tr, mapped.pos) : mapped.pos;
  if (at === null) return null;
  const inserted =
    candidate.wrap === null ? content : Fragment.from(candidate.wrap.create(null, content));
  if (tr.maybeStep(new ReplaceStep(at, at, new Slice(inserted, 0, 0))).failed) {
    return null;
  }
  const first = candidate.wrap === null ? at : at + 1;
  const node = tr.doc.nodeAt(first);
  if (content.childCount === 1 && node !== null && NodeSelection.isSelectable(node)) {
    tr.setSelection(NodeSelection.create(tr.doc, first));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(first + 1)));
  }
  return tr.scrollIntoView();
}

// ---------------------------------------------------------------------------
// The browser half: measuring, drawing, dropping.
// ---------------------------------------------------------------------------

interface DropPlugin {
  /** The dragged blocks, faded while they are carried. */
  source: BlockDropSource | null;
  /**
   * The block the dropped one will follow, or sit under as a sub-item: its row
   * is tinted, so the level reads from the neighbour as well as from the line.
   */
  anchor: number | null;
}

export const blockDropKey = new PluginKey<DropPlugin>('exocortexBlockDrop');

/**
 * Whether a block is being carried right now. Anything that floats over the
 * page (the formatting toolbar, for one) stays away meanwhile: the handle
 * selects the block it lifts, and a toolbar drawn for that selection would sit
 * exactly where the block is about to land and take the drop.
 */
export function isCarryingBlock(state: EditorState): boolean {
  return (blockDropKey.getState(state)?.source ?? null) !== null;
}

const CLEARED: DropPlugin = { source: null, anchor: null };

/** A candidate, measured: where its line goes on the screen. */
interface MeasuredCandidate {
  candidate: BlockDropCandidate;
  left: number;
  right: number;
  top: number;
  /** The text block whose row is tinted while this place is aimed at. */
  anchor: number | null;
  /**
   * Where the shallowest level of the same gap starts: the line is drawn
   * faint from there to `left`, the reach of the levels the pointer could
   * still move to, and solid from `left` on.
   */
  trackLeft: number;
}

/** What one drag remembers between `dragover` events. */
interface DragSession {
  source: BlockDropSource;
  wrap: NodeType | null;
  /** Pointer x minus the dragged block's text start, taken when it was grabbed. */
  grabOffset: number;
  /** How far a list's items stand in from the list, in pixels. */
  indent: number;
  /** Where the line points now, so the drop takes exactly that place. */
  target: MeasuredCandidate | null;
}

/**
 * The box a block's text starts in: a list item's is its first paragraph,
 * because the item's own box starts at the bullet or the checkbox.
 */
function blockRect(view: EditorView, pos: number): DOMRect | null {
  const node = view.state.doc.nodeAt(pos);
  const measured =
    node !== null && LIST_ITEM_TYPE_NAMES.has(node.type.name) && node.firstChild !== null
      ? pos + 1
      : pos;
  const dom = view.nodeDOM(measured);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

/** The first or last top-level block that has a box, for clamping the pointer. */
function edgeRect(view: EditorView, edge: 'first' | 'last'): DOMRect | null {
  let element = edge === 'first' ? view.dom.firstElementChild : view.dom.lastElementChild;
  while (element !== null) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
    element = edge === 'first' ? element.nextElementSibling : element.previousElementSibling;
  }
  return null;
}

/** Where a candidate's line goes, or `null` when there is nothing to measure. */
function measure(
  view: EditorView,
  candidate: BlockDropCandidate,
  indent: number,
): MeasuredCandidate | null {
  const $pos = view.state.doc.resolve(candidate.pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const beforeRect = before === null ? null : blockRect(view, candidate.pos - before.nodeSize);
  const afterRect = after === null ? null : blockRect(view, candidate.pos);
  const reference = beforeRect ?? afterRect;
  if (reference === null) return null;
  const { left, right } = landingEdges(view, candidate, reference, indent);
  return {
    candidate,
    left,
    right: Math.max(right, left + 24),
    top: lineTop(view, candidate.pos, reference),
    anchor: before === null ? null : anchorOf(view.state.doc, candidate.pos - before.nodeSize),
    trackLeft: left,
  };
}

/**
 * Where the dropped block's text will start and how far its container
 * reaches. A split puts the block beside the list, not into it: its text
 * starts where the list starts, and it runs as wide as whatever holds the
 * list. The line runs to the right edge of the container it lands in: a task
 * item's paragraph is shrunk to its words, its row is not.
 */
function landingEdges(
  view: EditorView,
  candidate: BlockDropCandidate,
  reference: DOMRect,
  indent: number,
): { left: number; right: number } {
  const $pos = view.state.doc.resolve(candidate.pos);
  const split = candidate.split === true && $pos.depth > 0;
  const listBox = split ? outerRect(view, $pos.before()) : null;
  const depth = split ? $pos.depth - 1 : $pos.depth;
  const container = depth > 0 ? view.nodeDOM($pos.before(depth)) : view.dom;
  const right =
    container instanceof HTMLElement ? container.getBoundingClientRect().right : reference.right;
  const left = (listBox ?? reference).left + (candidate.wrap === null ? 0 : indent);
  return { left, right };
}

/**
 * The line's height: halfway between the bottom of the block above and the
 * top of the one below. The bottom of the item above, not of its first
 * paragraph: the line has to clear a sub-list the item holds.
 */
function lineTop(view: EditorView, pos: number, reference: DOMRect): number {
  const $pos = view.state.doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  const beforeBottom =
    before === null ? null : (outerRect(view, pos - before.nodeSize)?.bottom ?? null);
  const afterTop = after === null ? null : (outerRect(view, pos)?.top ?? null);
  if (beforeBottom !== null && afterTop !== null && afterTop >= beforeBottom) {
    return (beforeBottom + afterTop) / 2;
  }
  return beforeBottom ?? afterTop ?? reference.top;
}

/**
 * The row that says "after this" or "under this": the block right before the
 * place, a list item by its own text. A whole list or another container
 * before the place has no single row, and nothing is tinted.
 */
function anchorOf(doc: PmNode, pos: number): number | null {
  const node = doc.nodeAt(pos);
  if (node === null) return null;
  if (LIST_ITEM_TYPE_NAMES.has(node.type.name))
    return node.firstChild?.isTextblock === true ? pos + 1 : null;
  return isDropLeaf(node) ? pos : null;
}

function outerRect(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

/**
 * Picks the level whose text start is nearest to where the carried block's
 * text start would be. Ties go to the place that needs no new list, so a gap
 * below a list's last item offers the list before a second list next to it.
 */
function closest(measured: readonly MeasuredCandidate[], left: number): MeasuredCandidate | null {
  let best: MeasuredCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of measured) {
    const extra = entry.candidate.wrap === null && entry.candidate.split !== true ? 0 : 0.5;
    const distance = Math.abs(entry.left - left) + extra;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The node a drag carries. ProseMirror keeps it on `view.dragging` at run time
 * and uses it to delete the original on drop, but leaves it out of the public
 * type; the drag handle sets it for the same reason.
 */
function draggedNode(dragging: object): NodeSelection | undefined {
  const { node } = dragging as { node?: unknown };
  return node instanceof NodeSelection ? node : undefined;
}

class BlockDropView {
  private session: DragSession | null = null;
  /** Pointer x when the current drag began, wherever it began. */
  private grabX: number | null = null;
  private line: HTMLElement | null = null;

  private readonly onDragStart = (event: DragEvent): void => {
    this.grabX = event.clientX;
  };

  private readonly onDragEnd = (): void => {
    this.grabX = null;
    this.finish();
  };

  /** Hides the line while the pointer is over anything but this editor. */
  private readonly onDocumentDragOver = (event: DragEvent): void => {
    if (event.target instanceof Node && this.view.dom.contains(event.target)) return;
    this.hideLine();
    if (this.session !== null) this.session.target = null;
  };

  constructor(private readonly view: EditorView) {
    const { ownerDocument } = view.dom;
    // Capture: the drag handle sits outside the editor, and the plugin that
    // owns it handles its own `dragstart` before anything bubbles.
    ownerDocument.addEventListener('dragstart', this.onDragStart, true);
    ownerDocument.addEventListener('dragend', this.onDragEnd);
    ownerDocument.addEventListener('dragover', this.onDocumentDragOver);
  }

  destroy(): void {
    const { ownerDocument } = this.view.dom;
    ownerDocument.removeEventListener('dragstart', this.onDragStart, true);
    ownerDocument.removeEventListener('dragend', this.onDragEnd);
    ownerDocument.removeEventListener('dragover', this.onDocumentDragOver);
    this.hideLine();
  }

  /** Starts a session for the drag in progress, or `null` when it is not ours. */
  private begin(event: DragEvent): DragSession | null {
    if (this.session !== null) return this.session;
    const { dragging } = this.view;
    if (dragging === null) return null;
    const source = blockDropSource(this.view.state, dragging.slice, draggedNode(dragging));
    if (source === null) return null;
    const sourceRect = blockRect(this.view, source.from);
    if (sourceRect === null) return null;
    const wrap = dropWrapType(this.view.state.doc, source, dragging.slice.content);
    const $from = this.view.state.doc.resolve(source.from);
    const listDom = $from.depth > 0 ? this.view.nodeDOM($from.before()) : null;
    const indent =
      wrap !== null && listDom instanceof HTMLElement
        ? Math.max(12, sourceRect.left - listDom.getBoundingClientRect().left)
        : 24;
    this.session = {
      source,
      wrap,
      grabOffset: (this.grabX ?? event.clientX) - sourceRect.left,
      indent,
      target: null,
    };
    this.view.dispatch(this.view.state.tr.setMeta(blockDropKey, { source, anchor: null }));
    return this.session;
  }

  /** The place the pointer at (x, y) aims at, measured. */
  private aim(session: DragSession, x: number, y: number): MeasuredCandidate | null {
    const { view } = this;
    const first = edgeRect(view, 'first');
    const last = edgeRect(view, 'last');
    if (first === null || last === null) return null;
    const left = Math.min(Math.max(x, first.left + 4), first.right - 4);
    const top = Math.min(Math.max(y, first.top + 1), last.bottom - 1);
    const found = view.posAtCoords({ left, top });
    if (found === null) return null;
    const { doc } = view.state;
    const leafPos = dropLeafAt(doc, found.pos, found.inside);
    if (leafPos === null) return null;
    const leafRect = outerRect(view, leafPos);
    if (leafRect === null) return null;
    const gap = dropGap(doc, leafPos, top > leafRect.top + leafRect.height / 2);
    const content = view.dragging?.slice.content;
    if (content === undefined) return null;
    const measured = blockDropCandidates(doc, gap, content, session.source, session.wrap)
      .map((candidate) => measure(view, candidate, session.indent))
      .filter((entry): entry is MeasuredCandidate => entry !== null);
    const best = closest(measured, x - session.grabOffset);
    if (best === null) return null;
    const trackLeft = Math.min(...measured.map((entry) => entry.left));
    return { ...best, trackLeft };
  }

  dragover(event: DragEvent): void {
    if (!this.view.editable) return;
    const session = this.begin(event);
    if (session === null) return;
    session.target = this.aim(session, event.clientX, event.clientY);
    this.setAnchor(session, session.target?.anchor ?? null);
    if (session.target === null) {
      this.hideLine();
      // Nowhere to land here, so nothing lands: the browser shows a refusal
      // instead of the drop putting the block somewhere unannounced.
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
      return;
    }
    this.drawLine(session.target);
  }

  drop(event: DragEvent, slice: Slice, move: boolean): boolean {
    const session = this.begin(event);
    if (session === null) return false;
    const target = this.aim(session, event.clientX, event.clientY) ?? session.target;
    const content = slice.openStart === 0 && slice.openEnd === 0 ? slice.content : null;
    const tr =
      target === null || content === null
        ? null
        : blockDropTransaction(this.view.state, session.source, target.candidate, content, move);
    this.session = null;
    this.hideLine();
    if (tr === null) {
      this.view.dispatch(this.view.state.tr.setMeta(blockDropKey, CLEARED));
      return true;
    }
    this.view.focus();
    this.view.dispatch(tr.setMeta(blockDropKey, CLEARED).setMeta('uiEvent', 'drop'));
    return true;
  }

  private finish(): void {
    this.hideLine();
    if (this.session === null) return;
    this.session = null;
    // The view may be gone already when a drag ends after navigation.
    if (this.view.isDestroyed) return;
    this.view.dispatch(this.view.state.tr.setMeta(blockDropKey, CLEARED));
  }

  /** Tints the row of the place aimed at, dispatching only when it changes. */
  private setAnchor(session: DragSession, anchor: number | null): void {
    const { source } = session;
    // Dropped right where it is: the carried block is no neighbour of itself.
    const own = anchor !== null && anchor >= source.from && anchor < source.to;
    const next = own ? null : anchor;
    const current = blockDropKey.getState(this.view.state)?.anchor ?? null;
    if (current === next) return;
    this.view.dispatch(this.view.state.tr.setMeta(blockDropKey, { source, anchor: next }));
  }

  private drawLine(target: MeasuredCandidate): void {
    const parent = this.view.dom.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    if (this.line === null) {
      this.line = parent.ownerDocument.createElement('div');
      this.line.className = 'exocortex-drop-line';
      this.line.setAttribute('aria-hidden', 'true');
      this.line.dataset.testid = 'block-drop-line';
      // The solid part: the level the block lands on.
      this.line.appendChild(parent.ownerDocument.createElement('span'));
      parent.appendChild(this.line);
    }
    const parentRect = parent.getBoundingClientRect();
    const originLeft = parentRect.left - parent.scrollLeft;
    const originTop = parentRect.top - parent.scrollTop;
    this.line.style.left = `${target.trackLeft - originLeft}px`;
    this.line.style.top = `${target.top - originTop}px`;
    this.line.style.width = `${target.right - target.trackLeft}px`;
    this.line.style.setProperty('--drop-level-offset', `${target.left - target.trackLeft}px`);
    const { depth } = this.view.state.doc.resolve(target.candidate.pos);
    this.line.dataset.level = String(target.candidate.split === true ? depth - 1 : depth);
  }

  private hideLine(): void {
    this.line?.remove();
    this.line = null;
  }
}

/**
 * The extension: decides and draws the drop of a dragged block, and fades the
 * blocks being carried. Behaviour only, no schema.
 */
export const BlockDrop = Extension.create({
  name: 'blockDrop',

  addProseMirrorPlugins() {
    let dropView: BlockDropView | null = null;
    return [
      new Plugin<DropPlugin>({
        key: blockDropKey,
        state: {
          init: () => CLEARED,
          apply(tr, value) {
            const meta = tr.getMeta(blockDropKey) as DropPlugin | undefined;
            if (meta !== undefined) return meta;
            if (value.source === null || !tr.docChanged) return value;
            const from = tr.mapping.map(value.source.from, 1);
            const to = tr.mapping.map(value.source.to, -1);
            // The tint is redrawn by the next `dragover`.
            return { source: from < to ? { from, to } : null, anchor: null };
          },
        },
        view: (view) => {
          dropView = new BlockDropView(view);
          return {
            destroy: () => {
              dropView?.destroy();
              dropView = null;
            },
          };
        },
        props: {
          decorations(state) {
            const { source, anchor } = blockDropKey.getState(state) ?? CLEARED;
            if (source === null) return null;
            const decorations: Decoration[] = [];
            const anchorNode = anchor === null ? null : state.doc.nodeAt(anchor);
            if (anchor !== null && anchorNode !== null) {
              decorations.push(
                Decoration.node(anchor, anchor + anchorNode.nodeSize, {
                  class: 'exocortex-drop-anchor',
                }),
              );
            }
            state.doc.nodesBetween(source.from, source.to, (node, pos) => {
              if (pos < source.from) return true;
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, { class: 'exocortex-drag-source' }),
              );
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleDOMEvents: {
            dragover: (_view, event) => {
              dropView?.dragover(event);
              return false;
            },
          },
          handleDrop: (_view, event, slice, moved) => dropView?.drop(event, slice, moved) ?? false,
        },
      }),
    ];
  },
});
