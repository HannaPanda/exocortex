import { type Editor } from '@tiptap/core';
import { type Node as PmNode, type NodeType } from '@tiptap/pm/model';
import { NodeSelection, type Selection, TextSelection, type Transaction } from '@tiptap/pm/state';

import { type BlockCatalogEntry } from './block-catalog';
import { isListItemNode, type LiftedListItem, liftListItemOut } from './list-split';

/**
 * The selection that stands for one whole block (issue #229).
 *
 * The block handle's menu converts and colours "this block", but the catalog's
 * conversions and the colour mark both work on the selection, and opening the
 * menu does not move it: "Umwandeln in" changed the block holding the caret,
 * and a colour on a collapsed caret only set a stored mark nobody saw. So the
 * menu first selects the block it belongs to, the way a person would by
 * selecting all of its text, and runs the ordinary command on that.
 *
 * - A text block: all of its text, so a colour covers every word.
 * - A block holding others (a list item with its sub-items, a quote, a
 *   callout, a toggle): from the start of its first text block to the end of
 *   its last. A list toggle then acts on the list the item stands in, a quote
 *   toggle on the whole quote, and a colour on everything the block carries,
 *   which is what moves with it when it is dragged.
 * - A block without text (a picture, a divider, an embed): the block itself.
 *
 * An empty text block yields a caret inside it, and a block that is gone or
 * cannot be selected yields `null`, so the action does nothing rather than
 * falling back to the caret it was meant to ignore.
 */
export function blockContentSelection(doc: PmNode, pos: number): Selection | null {
  if (pos < 0 || pos >= doc.content.size) return null;
  const node = doc.nodeAt(pos);
  if (node === null || !node.isBlock) return null;
  if (node.isTextblock) return TextSelection.create(doc, pos + 1, pos + 1 + node.content.size);

  let from = -1;
  let to = -1;
  node.descendants((child, offset) => {
    if (!child.isTextblock) return true;
    const start = pos + 1 + offset + 1;
    if (from < 0) from = start;
    to = start + child.content.size;
    return false;
  });
  if (from >= 0) return TextSelection.create(doc, from, to);
  return NodeSelection.isSelectable(node) ? NodeSelection.create(doc, pos) : null;
}

/**
 * Runs an action meant for the selection on the block at `pos` instead.
 *
 * Selects the block (`blockContentSelection`), runs the action, and then
 * leaves the caret at the end of what the block's text became: the person
 * keeps writing where they just changed something, and no text selection is
 * left behind to raise the formatting toolbar over it. Selecting changes no
 * content, so `Strg+Z` takes back the action in one step and puts the block's
 * text back under the selection it had.
 *
 * Returns what the action returned, or `false` when there is no block at
 * `pos` to act on.
 */
export function runOnBlock(editor: Editor, pos: number, action: () => boolean): boolean {
  const selection = blockContentSelection(editor.state.doc, pos);
  if (selection === null) return false;
  editor.view.dispatch(editor.state.tr.setSelection(selection));
  const applied = action();
  const after = editor.state.selection;
  if (after instanceof TextSelection && !after.empty) {
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, after.to)),
    );
  }
  return applied;
}

/**
 * Turns the block at `pos` into the catalog entry's block, the way the handle's
 * menu means it (issues #229, #284).
 *
 * Any block but a list item goes through `runOnBlock`. A list item does not:
 * selected as a whole it spans its sub-items too, so "Absatz" changed
 * nothing, a quote or a callout could not wrap a paragraph that has to stay
 * the item's first child, and a heading landed on the last sub-item instead
 * of the item. So an item is taken out of its list first (`liftListItemOut`):
 * its text becomes a paragraph where it stood, its sub-items stay a list
 * directly underneath, and the list is split around it. Then
 *
 * - a list entry of the item's own kind is done (it toggles the list off),
 * - a list entry whose items are of another type (a task list from a bullet
 *   list, or back) makes the lifted blocks one item of a list of that kind,
 *   sub-items nested in it as before,
 * - any other entry runs on the lifted paragraph alone.
 *
 * A list entry whose items are of the same type (bullet and numbered) keeps
 * changing the whole list the item stands in, which is what the selection
 * spanning the item always did.
 *
 * The caret ends at the end of the item's text. The lift and the conversion
 * are adjacent changes made at once, so `Strg+Z` takes them back together.
 * Returns whether anything changed.
 */
export function turnBlockInto(editor: Editor, pos: number, entry: BlockCatalogEntry): boolean {
  const { doc } = editor.state;
  const item = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null;
  if (!isListItemNode(item)) return runOnBlock(editor, pos, () => entry.run(editor));

  const listType =
    entry.makesList === undefined ? null : (doc.type.schema.nodes[entry.makesList] ?? null);
  const newList = listType === doc.resolve(pos).parent.type ? null : listType;
  if (newList?.contentMatch.defaultType === item.type) {
    return runOnBlock(editor, pos, () => entry.run(editor));
  }

  const tr = editor.state.tr;
  const lifted = liftListItemOut(tr, pos);
  if (lifted === null) return false;
  const textStart = newList === null ? lifted.from + 1 : wrapInOwnList(tr, lifted, newList);
  if (textStart === null) return false;
  const text = tr.doc.nodeAt(textStart - 1);
  tr.setSelection(TextSelection.create(tr.doc, textStart + (text?.content.size ?? 0)));
  editor.view.dispatch(tr);

  if (listType === null && entry.isActive?.(editor) !== true) {
    runOnBlock(editor, lifted.from, () => entry.run(editor));
  }
  editor.commands.focus();
  return true;
}

/**
 * Makes a lifted item's blocks the one item of a new list of `list`'s kind,
 * its sub-lists nested in it as before. Returns where the item's text starts,
 * or `null` when the blocks cannot be such an item.
 */
function wrapInOwnList(tr: Transaction, lifted: LiftedListItem, list: NodeType): number | null {
  const itemType = list.contentMatch.defaultType;
  const blocks = tr.doc.slice(lifted.from, lifted.to).content;
  if (itemType === null || !itemType.validContent(blocks)) return null;
  tr.replaceWith(lifted.from, lifted.to, list.create(null, itemType.create(null, blocks)));
  // Into the new list, its item and the item's paragraph.
  return lifted.from + 3;
}
