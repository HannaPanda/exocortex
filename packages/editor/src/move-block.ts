import { Extension } from '@tiptap/core';
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';

import { isListItemNode, isListNode, liftListItemOut, LIST_ITEM_TYPE_NAMES } from './list-split';

/**
 * Moving a block up or down without a mouse (issue #243).
 *
 * The keyboard half of dragging: `Strg+Umschalt+Pfeil hoch/runter` swaps the
 * block the cursor is in with its neighbour, the same shortcut Notion uses.
 * "The block" is the one a person would grab: a list item rather than its
 * paragraph (so its sub-items travel with it and a numbered list renumbers
 * itself), a whole table rather than a cell, the selected image itself. It
 * moves among its siblings, and a neighbour that holds other blocks (a list, a
 * quote, a callout) is passed as a whole: a block from outside never ends up
 * inside one by moving.
 *
 * At the first or last place of a list, a quote or a callout the next press
 * takes the block out of it, to stand right before or after it (`edgeMove`):
 *
 * - a sub-item becomes an item of the list one level out, before or after the
 *   item that held it;
 * - an item of an outermost list becomes ordinary blocks, its text a
 *   paragraph and its sub-items a list underneath (`liftListItemOut`);
 * - a block in a quote or a callout leaves it, and the quote or callout stays.
 *
 * A block that is the only thing in its list, quote or callout takes it along
 * instead: what a person sees there is one bullet or one quote, and that is
 * what moves. Everywhere else (a column, a table cell, a toggle, the page) the
 * first and last place are the end of the road, and the key does nothing.
 */

/** The containers a block can be moved out of with the keyboard. */
const EXIT_CONTAINERS = new Set(['blockquote', 'callout']);

/** A block and where it starts. */
export interface MovableBlock {
  node: PmNode;
  pos: number;
}

/** The block the selection is in, as a person would grab it. */
export function movableBlockAt(state: EditorState): MovableBlock | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.node.isBlock) {
    return { node: selection.node, pos: selection.from };
  }
  const { $from } = selection;
  if ($from.depth === 0) return null;
  // A table moves whole: a paragraph shuffled between cells is not a move
  // anybody asks for.
  for (let depth = 1; depth <= $from.depth; depth += 1) {
    if ($from.node(depth).type.spec.tableRole === 'table') {
      return { node: $from.node(depth), pos: $from.before(depth) };
    }
  }
  let depth = $from.depth;
  if (
    depth >= 2 &&
    LIST_ITEM_TYPE_NAMES.has($from.node(depth - 1).type.name) &&
    $from.index(depth - 1) === 0
  ) {
    depth -= 1;
  }
  return { node: $from.node(depth), pos: $from.before(depth) };
}

/**
 * Moves the block at `pos` one place up (`-1`) or down (`1`): it swaps with
 * its neighbour, or at the edge of a list, quote or callout it leaves it
 * (`edgeMove`). `null` when it cannot move. A caret or selection inside the
 * block moves with it, so the next press moves it again.
 */
export function moveBlockTransaction(
  state: EditorState,
  pos: number,
  direction: 1 | -1,
): Transaction | null {
  const { doc } = state;
  const node = doc.nodeAt(pos);
  if (node === null || !node.isBlock) return null;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const parent = $pos.parent;
  // A list item's first child is its own text: nothing else trades places
  // with it, and nothing inside the item is moved above it.
  const first = isListItemNode(parent) ? 1 : 0;
  const atEdge = direction < 0 ? index <= first : index >= parent.childCount - 1;
  if (atEdge) return edgeMove(state, pos, direction);
  const end = pos + node.nodeSize;
  const tr = state.tr;
  let newPos: number;
  if (direction < 0) {
    const sibling = parent.child(index - 1);
    const siblingPos = pos - sibling.nodeSize;
    tr.delete(pos, end).insert(siblingPos, node);
    newPos = siblingPos;
  } else {
    const sibling = parent.child(index + 1);
    tr.delete(end, end + sibling.nodeSize).insert(pos, sibling);
    newPos = pos + sibling.nodeSize;
  }
  carrySelection(state, tr, pos, end, newPos - pos);
  return tr.scrollIntoView();
}

/**
 * Keeps a selection that lay inside the moved block `[from, to)` inside it:
 * every position in it is shifted by `shift`, the distance the block's
 * content travelled.
 */
function carrySelection(
  state: EditorState,
  tr: Transaction,
  from: number,
  to: number,
  shift: number,
): void {
  const { selection } = state;
  if (selection instanceof NodeSelection && selection.from === from) {
    tr.setSelection(NodeSelection.create(tr.doc, from + shift));
  } else if (selection.from >= from && selection.to <= to) {
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(selection.anchor + shift),
        tr.doc.resolve(selection.head + shift),
      ),
    );
  }
}

/**
 * The move past the first (`-1`) or last (`1`) place of the block's
 * container, or `null` when its container is none a block leaves this way.
 */
function edgeMove(state: EditorState, pos: number, direction: 1 | -1): Transaction | null {
  const { doc } = state;
  const node = doc.nodeAt(pos);
  const $pos = doc.resolve(pos);
  if (node === null || $pos.depth === 0) return null;
  const container = $pos.parent;
  const containerPos = $pos.before();
  const nested = isListNode(container) && isListItemNode($pos.node(-1));
  if (isListItemNode(node) && isListNode(container)) {
    if (nested) return outdentItem(state, pos, direction);
    // One bullet alone is what moves: its list goes with it.
    if (container.childCount === 1) return moveBlockTransaction(state, containerPos, direction);
    return liftItem(state, pos);
  }
  if (!EXIT_CONTAINERS.has(container.type.name)) return null;
  if (container.childCount === 1) return moveBlockTransaction(state, containerPos, direction);
  const end = pos + node.nodeSize;
  const target = direction < 0 ? containerPos : $pos.after();
  const tr = state.tr.delete(pos, end);
  const at = tr.mapping.map(target);
  tr.insert(at, node);
  carrySelection(state, tr, pos, end, at - pos);
  return tr.scrollIntoView();
}

/**
 * A sub-item at the edge of its sub-list becomes an item of the list one
 * level out, right before (`-1`) or after (`1`) the item that held it. A
 * sub-list it leaves empty goes with it.
 */
function outdentItem(state: EditorState, pos: number, direction: 1 | -1): Transaction | null {
  const { doc } = state;
  const node = doc.nodeAt(pos);
  if (node === null) return null;
  const $pos = doc.resolve(pos);
  const holder = direction < 0 ? $pos.before(-1) : $pos.after(-1);
  const end = pos + node.nodeSize;
  const tr = state.tr.deleteRange(pos, end);
  const at = tr.mapping.map(holder);
  const $at = tr.doc.resolve(at);
  if (!$at.parent.canReplace($at.index(), $at.index(), Fragment.from(node))) return null;
  tr.insert(at, node);
  carrySelection(state, tr, pos, end, at - pos);
  return tr.scrollIntoView();
}

/**
 * An item of an outermost list leaves it as ordinary blocks, standing right
 * where it stood: before the rest of the list when it was the first item,
 * after it when it was the last.
 */
function liftItem(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (node === null) return null;
  const tr = state.tr;
  const lifted = liftListItemOut(tr, pos);
  if (lifted === null) return null;
  if (state.selection instanceof NodeSelection && state.selection.from === pos) {
    // The selected item is gone; its text is what was moved.
    tr.setSelection(TextSelection.near(tr.doc.resolve(lifted.from + 1)));
  } else {
    // The item's content started one position inside it and now starts at `from`.
    carrySelection(state, tr, pos, pos + node.nodeSize, lifted.from - (pos + 1));
  }
  return tr.scrollIntoView();
}

/** `Strg+Umschalt+Pfeil hoch/runter` (Cmd on a Mac). */
export const MoveBlock = Extension.create({
  name: 'moveBlock',

  addKeyboardShortcuts() {
    const move = (direction: 1 | -1): boolean => {
      const { state, view } = this.editor;
      if (!this.editor.isEditable) return false;
      const block = movableBlockAt(state);
      if (block === null) return false;
      const tr = moveBlockTransaction(state, block.pos, direction);
      // At the edge the key is still taken: the browser would otherwise
      // extend a selection to the start of the paragraph, which is not what
      // somebody pressing "move up" meant.
      if (tr !== null) view.dispatch(tr);
      return true;
    };
    return {
      'Mod-Shift-ArrowUp': () => move(-1),
      'Mod-Shift-ArrowDown': () => move(1),
    };
  },
});
