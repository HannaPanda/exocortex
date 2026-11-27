import { type Node as PmNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { type Editor } from '@tiptap/react';

import {
  BLOCK_ID_ATTRIBUTE,
  type BlockCatalogEntry,
  runOnBlock,
  turnBlockInto,
} from '@exocortex/editor';

/** A block and where it starts, which is all any block action needs. */
export interface BlockTarget {
  node: PmNode;
  pos: number;
}

/**
 * Where a block stands *now*, which is not where it stood when it was picked.
 *
 * The identifier is the reliable handle: a position is only a guess once
 * anything above the block has changed, and between picking a block and
 * confirming its deletion there is a dialog's worth of time for that to happen.
 */
export function currentRangeOf(
  editor: Editor,
  block: BlockTarget,
): { from: number; to: number } | null {
  const blockId: unknown = block.node.attrs[BLOCK_ID_ATTRIBUTE];
  if (typeof blockId !== 'string' || blockId.length === 0) {
    const still = editor.state.doc.nodeAt(block.pos);
    if (still === null || still.type !== block.node.type) return null;
    return { from: block.pos, to: block.pos + still.nodeSize };
  }

  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range !== null) return false;
    if (node.attrs[BLOCK_ID_ATTRIBUTE] !== blockId) return true;
    range = { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return range;
}

/**
 * Runs an action written for the selection on the menu's block (issue #229).
 *
 * The conversions and colours work on the selection, and the handle's menu
 * opens without moving it, so on their own they changed whatever held the
 * caret. With a target the block is looked up again by its id and selected
 * first (`runOnBlock`); without one, which is how the selection toolbar opens
 * the same items, the selection the person made is the target.
 */
export function runOnTarget(
  editor: Editor,
  target: BlockTarget | null,
  action: () => boolean,
): boolean {
  if (target === null) return action();
  const range = currentRangeOf(editor, target);
  if (range === null) return false;
  return runOnBlock(editor, range.from, action);
}

/**
 * Turns the menu's block into a catalog entry's block (issues #229, #284).
 *
 * Like `runOnTarget`, but a list item is taken out of its list first rather
 * than converted as a selection spanning its sub-items (`turnBlockInto`), so
 * "Absatz" makes it an ordinary line. Without a target the toolbar's
 * selection is converted as it is.
 */
export function turnTargetInto(
  editor: Editor,
  target: BlockTarget | null,
  entry: BlockCatalogEntry,
): boolean {
  if (target === null) return entry.run(editor);
  const range = currentRangeOf(editor, target);
  if (range === null) return false;
  return turnBlockInto(editor, range.from, entry);
}

/**
 * Deletes a block and leaves the caret where it stood (issue #285).
 *
 * The menu deleted with `chain().focus().deleteRange()`. Opened from the
 * handle, the editor has no focus, so `focus()` put back the selection from
 * before the menu -- wherever the caret had last been, or the start of the
 * page if it had never been placed -- and scrolled that into view on the next
 * frame. The reader deleting a heading in the middle of a long page landed
 * at the top, or a screen further down. The caret now goes where the block
 * was, which is on screen, so focusing it scrolls nothing.
 */
export function deleteBlockRange(editor: Editor, range: { from: number; to: number }): void {
  const tr = editor.state.tr.delete(range.from, range.to);
  const at = Math.min(range.from, tr.doc.content.size);
  tr.setSelection(Selection.near(tr.doc.resolve(at)));
  editor.view.dispatch(tr);
  editor.commands.focus();
}
