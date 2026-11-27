import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { type Transaction } from '@tiptap/pm/state';

import { BLOCK_ID_ATTRIBUTE } from './block-id';

/**
 * Splitting a list where a block is put between two of its items (issue #243),
 * and turning a list item into ordinary blocks where it stood.
 *
 * A list in this schema is one node holding its items, so a paragraph cannot
 * stand between two items: the list has to become two lists with the
 * paragraph between them. Both halves are lists of the same kind (a numbered
 * list stays numbered, a task list keeps its tasks), every item keeps its
 * sub-items, and the half before keeps the list's identity. The half after is
 * a new list with an identifier of its own, and a numbered one starts again at
 * one, the way a list interrupted by a paragraph reads.
 *
 * A paragraph dropped between two items (`block-drop.ts`) and a list item
 * moved past the edge of its list with the keyboard (`move-block.ts`) use
 * them. `liftListItemOut` is also what "Absatz" in the handle's menu needs for
 * a list item (issue #284): the same lift, for an item anywhere in its list.
 */

/** The node types that hold list items. */
export const LIST_TYPE_NAMES: ReadonlySet<string> = new Set([
  'bulletList',
  'orderedList',
  'taskList',
]);

/** The node types that are list items. */
export const LIST_ITEM_TYPE_NAMES: ReadonlySet<string> = new Set(['listItem', 'taskItem']);

export function isListNode(node: PmNode | null | undefined): node is PmNode {
  return node !== null && node !== undefined && LIST_TYPE_NAMES.has(node.type.name);
}

export function isListItemNode(node: PmNode | null | undefined): node is PmNode {
  return node !== null && node !== undefined && LIST_ITEM_TYPE_NAMES.has(node.type.name);
}

/**
 * The attributes of the second half of a split list: the list's own, without
 * its identifier (the block-id plugin gives the new list one) and, for a
 * numbered list, starting again at its default.
 */
export function splitListAttrs(list: PmNode): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...list.attrs };
  if (BLOCK_ID_ATTRIBUTE in attrs) attrs[BLOCK_ID_ATTRIBUTE] = null;
  if ('start' in attrs) attrs.start = list.type.create(null).attrs.start as unknown;
  return attrs;
}

/**
 * Makes room between two items of a list: splits the list that `pos` stands
 * directly in and returns the position between the two halves, where any
 * block can then be inserted.
 *
 * At the list's very start or end nothing is split and the position before or
 * after the whole list comes back, so no empty list is ever left behind. A
 * position that is not directly inside a list gives `null`.
 */
export function splitListAt(tr: Transaction, pos: number): number | null {
  const $pos = tr.doc.resolve(pos);
  const list = $pos.parent;
  if ($pos.depth === 0 || !isListNode(list)) return null;
  const index = $pos.index();
  if (index === 0) return $pos.before();
  if (index >= list.childCount) return $pos.after();
  tr.split(pos, 1, [{ type: list.type, attrs: splitListAttrs(list) }]);
  return pos + 1;
}

/**
 * What a list item becomes outside its list: its own text as the paragraph it
 * already is, followed by whatever else it holds. Sub-lists stay lists, so the
 * sub-items stand directly underneath, one level further out. A task item's
 * tick has no place outside a task list and is not kept.
 */
export function listItemBlocks(item: PmNode): Fragment {
  return item.content;
}

/** Where a lifted item's blocks ended up. */
export interface LiftedListItem {
  from: number;
  to: number;
}

/**
 * Turns the list item at `itemPos` into ordinary blocks standing where it
 * stood, one level out (`listItemBlocks`): the list is split around it, the
 * items before and after stay lists of the same kind, and a list that held
 * only this item is replaced by its blocks. One step in `tr`, so one
 * `Strg+Z` takes it back.
 *
 * Returns where the blocks now stand, or `null` (and `tr` unchanged) when
 * `itemPos` is not an item of a list or its blocks cannot stand where the
 * list stands.
 */
export function liftListItemOut(tr: Transaction, itemPos: number): LiftedListItem | null {
  const $item = tr.doc.resolve(itemPos);
  const item = $item.nodeAfter;
  const list = $item.parent;
  if ($item.depth === 0 || !isListItemNode(item) || !isListNode(list)) return null;
  const blocks = listItemBlocks(item);
  const index = $item.index();
  const listPos = $item.before();
  // What will stand where the list stands now, as a check before anything moves.
  let probe = blocks;
  if (index > 0) probe = Fragment.from(list).append(probe);
  if (index < list.childCount - 1) probe = probe.append(Fragment.from(list));
  const holder = $item.node(-1);
  const listIndex = $item.index(-1);
  if (!holder.canReplace(listIndex, listIndex + 1, probe)) return null;

  if (list.childCount === 1) {
    tr.replaceWith(listPos, listPos + list.nodeSize, blocks);
    return { from: listPos, to: listPos + blocks.size };
  }
  tr.delete(itemPos, itemPos + item.nodeSize);
  const at = splitListAt(tr, itemPos);
  if (at === null) return null;
  tr.insert(at, blocks);
  return { from: at, to: at + blocks.size };
}
