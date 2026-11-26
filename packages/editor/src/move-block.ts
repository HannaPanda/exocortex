import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';

/**
 * Moving a block up or down without a mouse (issue #243).
 *
 * The keyboard half of dragging: `Strg+Umschalt+Pfeil hoch/runter` swaps the
 * block the cursor is in with its neighbour, the same shortcut Notion uses.
 * "The block" is the one a person would grab: a list item rather than its
 * paragraph (so its sub-items travel with it and a numbered list renumbers
 * itself), a whole table rather than a cell, the selected image itself. It
 * moves among its siblings; at the first or last place of its list or
 * container the key does nothing rather than reaching into a neighbour.
 */

const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);

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
    LIST_ITEM_TYPES.has($from.node(depth - 1).type.name) &&
    $from.index(depth - 1) === 0
  ) {
    depth -= 1;
  }
  return { node: $from.node(depth), pos: $from.before(depth) };
}

/**
 * Swaps the block at `pos` with its previous (`-1`) or next (`1`) sibling, or
 * `null` when there is none. A caret or selection inside the block moves with
 * it, so the next press moves it again.
 */
export function moveBlockTransaction(
  state: EditorState,
  pos: number,
  direction: 1 | -1,
): Transaction | null {
  const { doc, selection } = state;
  const node = doc.nodeAt(pos);
  if (node === null || !node.isBlock) return null;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const parent = $pos.parent;
  const end = pos + node.nodeSize;
  const tr = state.tr;
  let newPos: number;
  if (direction < 0) {
    if (index === 0) return null;
    const sibling = parent.child(index - 1);
    const siblingPos = pos - sibling.nodeSize;
    tr.delete(pos, end).insert(siblingPos, node);
    newPos = siblingPos;
  } else {
    if (index >= parent.childCount - 1) return null;
    const sibling = parent.child(index + 1);
    tr.delete(end, end + sibling.nodeSize).insert(pos, sibling);
    newPos = pos + sibling.nodeSize;
  }
  const shift = newPos - pos;
  if (selection instanceof NodeSelection && selection.from === pos) {
    tr.setSelection(NodeSelection.create(tr.doc, newPos));
  } else if (selection.from >= pos && selection.to <= end) {
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(selection.anchor + shift),
        tr.doc.resolve(selection.head + shift),
      ),
    );
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
