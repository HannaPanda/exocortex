import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';

import { isListItemNode, isListNode } from './list-split';

/**
 * Sorting a list once, on request (issue #253).
 *
 * "Sortieren" in the handle's menu puts the items of one list into an order:
 * by their text, by the first number in it, or for a task list the open tasks
 * before the done ones. It is an action, not a mode: nothing is re-sorted
 * when a box is ticked or a word is typed, the list keeps whatever order it is
 * given afterwards, and `Strg+Z` takes the sort back in one step. A mode would
 * move a line away under somebody's cursor the moment a collaborator ticked
 * it, and would have to be stored somewhere other than the canonical Yjs
 * state (ADR-004/005) to be a mode at all.
 *
 * Only the items of the one list move, each with everything nested under it,
 * so a sub-list keeps its own order and its own parent. Every sort is stable:
 * items that compare equal keep the order they had, which is what makes "done
 * to the bottom" leave both halves as they were.
 */

/** The orders a list can be put into. */
export type ListSortOrder = 'alphabetical' | 'numeric' | 'checked';

/** A list and where it starts. */
export interface SortableList {
  node: PmNode;
  pos: number;
}

/**
 * The list an action on the block at `pos` sorts: the list itself, or for a
 * list item the list it stands in. `null` for anything else.
 */
export function sortableListAt(doc: PmNode, pos: number): SortableList | null {
  const node = doc.nodeAt(pos);
  if (isListNode(node)) return { node, pos };
  if (!isListItemNode(node)) return null;
  const $pos = doc.resolve(pos);
  if (!isListNode($pos.parent)) return null;
  return { node: $pos.parent, pos: $pos.before() };
}

/**
 * The innermost list around the selection, which is what the selection
 * toolbar's menu sorts: the sub-list when the caret is in a sub-item.
 */
export function sortableListAtSelection(state: EditorState): SortableList | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    const own = sortableListAt(state.doc, selection.from);
    if (own !== null) return own;
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (isListNode(node)) return { node, pos: $from.before(depth) };
  }
  return null;
}

/**
 * The orders that mean something for `list`: none for a list of one item,
 * and "done to the bottom" only where there are boxes to tick.
 */
export function listSortOrders(list: PmNode): ListSortOrder[] {
  if (!isListNode(list) || list.childCount < 2) return [];
  return list.type.name === 'taskList'
    ? ['checked', 'alphabetical', 'numeric']
    : ['alphabetical', 'numeric'];
}

/** An item's own text: its first block, never its sub-items. */
function ownText(item: PmNode): string {
  return (item.firstChild?.textContent ?? '').trim();
}

/**
 * The first number in a text, or `null`: "Kapitel 12" is 12, "-3 °C" is -3,
 * "2,5 kg" and "2.5 kg" are both 2.5. A minus counts only where it does not
 * join two words ("Version-2" is 2). One separator is read as the decimal
 * point; thousands separators are not guessed at, because "1.500" is 1500 in
 * German and 1.5 in English.
 */
export function leadingNumberOf(text: string): number | null {
  const match = /(?<![\p{L}\p{N}])-?\d+(?:[.,]\d+)?/u.exec(text);
  if (match === null) return null;
  const value = Number(match[0].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Compares two items for `order`. Items without a key (no text, no number)
 * go after the ones with one, in the order they had.
 */
function comparatorFor(
  order: ListSortOrder,
  locale: string | undefined,
): (a: PmNode, b: PmNode) => number {
  if (order === 'checked') {
    return (a, b) => Number(a.attrs.checked === true) - Number(b.attrs.checked === true);
  }
  if (order === 'numeric') {
    return (a, b) => {
      const x = leadingNumberOf(ownText(a));
      const y = leadingNumberOf(ownText(b));
      if (x === null || y === null) return Number(x === null) - Number(y === null);
      return x - y;
    };
  }
  // `numeric` makes "Punkt 9" come before "Punkt 10"; `base` ignores case and
  // accents, so "äpfel" and "Apfel" stand together.
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  return (a, b) => {
    const x = ownText(a);
    const y = ownText(b);
    if (x === '' || y === '') return Number(x === '') - Number(y === '');
    return collator.compare(x, y);
  };
}

/**
 * Sorts the items of the list at `listPos` into `order`, as one transaction.
 * `null` when there is no list there or the order would not change, so a
 * sort that does nothing leaves no step to undo. A caret or selection inside
 * one item travels with that item.
 */
export function sortListTransaction(
  state: EditorState,
  listPos: number,
  order: ListSortOrder,
  locale?: string,
): Transaction | null {
  const list = state.doc.nodeAt(listPos);
  if (!isListNode(list) || !listSortOrders(list).includes(order)) return null;

  const items: { node: PmNode; from: number }[] = [];
  list.forEach((node, offset) => {
    items.push({ node, from: listPos + 1 + offset });
  });
  const compare = comparatorFor(order, locale);
  // Array.prototype.sort is stable, so equal items keep their order.
  const sorted = [...items].sort((a, b) => compare(a.node, b.node));
  if (sorted.every((item, index) => item === items[index])) return null;

  const tr = state.tr.replaceWith(
    listPos + 1,
    listPos + list.nodeSize - 1,
    Fragment.fromArray(sorted.map((item) => item.node)),
  );

  // Where each item starts now, to carry a selection inside it along.
  let at = listPos + 1;
  for (const item of sorted) {
    const end = item.from + item.node.nodeSize;
    const { selection } = state;
    if (selection instanceof NodeSelection && selection.from === item.from) {
      tr.setSelection(NodeSelection.create(tr.doc, at));
    } else if (selection.from >= item.from && selection.to <= end) {
      const shift = at - item.from;
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(selection.anchor + shift),
          tr.doc.resolve(selection.head + shift),
        ),
      );
    }
    at += item.node.nodeSize;
  }
  return tr;
}
