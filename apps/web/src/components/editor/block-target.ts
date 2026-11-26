import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';

import { BLOCK_ID_ATTRIBUTE, runOnBlock } from '@exocortex/editor';

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
