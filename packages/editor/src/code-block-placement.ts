import { type Attrs, type Node as PmNode, type NodeType } from '@tiptap/pm/model';
import { EditorState, type Selection, TextSelection, type Transaction } from '@tiptap/pm/state';

import { isListItemNode, liftListItemOut } from './list-split';

/**
 * Where a new code block goes (issue #318).
 *
 * The catalog's "Codeblock", `Mod-Alt-c` and the ``` fence all ended in
 * `setBlockType`, which turns the text block holding the caret into the code
 * block. That is right for a free paragraph and wrong for a list item: its
 * first paragraph has to stay a paragraph, so Tiptap's `setNode` first lifted
 * it out of every list around it (`clearNodes`) and only then converted it.
 * The item's text went into the code, the list was split around it, a nested
 * sibling lost its indentation, and an item with sub-items changed nothing at
 * all. The usual way there is `Umschalt+Enter` for a fresh line under the
 * item's text, which is still the same paragraph, so the text above came
 * along. The fence never fired in a list item or after a line break.
 *
 * The rule, the way Notion keeps it:
 *
 * - **An empty line becomes the code block.** An empty paragraph turns into
 *   one where it stands; an empty list item is replaced by it, the list split
 *   around it and its sub-items kept as a list underneath (`liftListItemOut`).
 *   An empty line after `Umschalt+Enter` is taken out of its paragraph, and the
 *   code block stands where that line stood, inside the same container.
 * - **Text stays where it is.** A list item's text cannot become a code block
 *   without leaving its list, so the new, empty code block goes directly under
 *   it, inside the same item, indented as its child. A free text block (a
 *   paragraph, a heading, a second paragraph in an item) still turns into the
 *   code block where it stands: nothing has to move for that.
 * - **A selection becomes code, and only the selection.** A selection inside
 *   one text block is cut out of it, becomes the code block, and the text
 *   before and after stays in place around it. A selection of a list item's
 *   whole text replaces the item like an empty one, which is also what
 *   "Umwandeln in" in the handle's menu does (issue #284).
 *
 * Everything happens in `tr`, in one dispatch, so `Strg+Z` takes it back at
 * once. Returns `false`, with `tr` untouched, where the rule has nothing to say: the
 * caret is already in a code block, the selection spans several blocks, or the
 * container takes no code block. The caller then falls back to the old
 * command.
 */
export function placeCodeBlock(tr: Transaction, type: NodeType, attrs: Attrs | null): boolean {
  const planned = planCodeBlock(tr.doc, tr.selection, type, attrs);
  if (planned === null) return false;
  for (const step of planned.steps) tr.step(step);
  const { anchor, head } = planned.selection;
  tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  return true;
}

/**
 * The same change on a transaction of its own, or `null`. Working on a copy
 * keeps a half-done placement (a line removed, then no room for the code
 * block) from ever reaching the caller's transaction.
 */
export function planCodeBlock(
  doc: PmNode,
  selection: Selection,
  type: NodeType,
  attrs: Attrs | null,
): Transaction | null {
  if (!(selection instanceof TextSelection)) return null;
  const tr = EditorState.create({ doc, selection }).tr;
  return place(tr, type, attrs) ? tr : null;
}

function place(tr: Transaction, type: NodeType, attrs: Attrs | null): boolean {
  const { selection } = tr;
  if (!(selection instanceof TextSelection)) return false;
  const { $from, $to } = selection;
  const block = $from.parent;
  if (!block.isTextblock || block.type === type || !$from.sameParent($to)) return false;

  const blockPos = $from.before();
  const start = $from.start();
  const end = $from.end();

  if (!selection.empty) {
    if ($from.pos === start && $to.pos === end) return replaceLine(tr, blockPos, type, attrs);
    return extractSelection(tr, blockPos, type, attrs);
  }
  if (block.content.size === 0) return replaceLine(tr, blockPos, type, attrs);

  const line = lineAround(block, $from.parentOffset);
  if (line.from === line.to) return replaceEmptyLine(tr, blockPos, line, type, attrs);
  if (canBecome(tr.doc, blockPos, type)) return convert(tr, blockPos, type, attrs);
  if (isItemText(tr.doc, blockPos)) return insertAfter(tr, blockPos, type, attrs);
  return false;
}

/** Whether `node` is a line break inside a text block (`hardBreak`). */
function isLineBreak(node: PmNode | null | undefined): boolean {
  return node?.type.spec.linebreakReplacement === true;
}

/**
 * The line of `block` the offset stands on: from just after the line break
 * before it (or the block's start) to the next line break (or the block's
 * end), as offsets into the block.
 */
function lineAround(block: PmNode, offset: number): { from: number; to: number } {
  let from = 0;
  let to = block.content.size;
  block.forEach((child, childOffset) => {
    if (!isLineBreak(child)) return;
    if (childOffset < offset) from = childOffset + child.nodeSize;
    else if (to === block.content.size) to = childOffset;
  });
  return { from, to };
}

/** Whether the text block at `blockPos` may turn into `type` where it stands. */
function canBecome(doc: PmNode, blockPos: number, type: NodeType): boolean {
  const $block = doc.resolve(blockPos);
  return $block.parent.canReplaceWith($block.index(), $block.index() + 1, type);
}

/** Whether the text block at `blockPos` is a list item's own text, its first child. */
function isItemText(doc: PmNode, blockPos: number): boolean {
  const $block = doc.resolve(blockPos);
  return $block.depth > 0 && isListItemNode($block.parent) && $block.index() === 0;
}

/** Turns the text block at `blockPos` into the code block, caret at its end. */
function convert(tr: Transaction, blockPos: number, type: NodeType, attrs: Attrs | null): boolean {
  tr.setBlockType(blockPos + 1, blockPos + 1, type, attrs);
  const code = tr.doc.nodeAt(blockPos);
  if (code?.type !== type) return false;
  tr.setSelection(TextSelection.create(tr.doc, blockPos + 1 + code.content.size));
  return true;
}

/**
 * The whole line becomes the code block: in place where the container allows
 * it, or, for a list item's text, in place of the item.
 */
function replaceLine(
  tr: Transaction,
  blockPos: number,
  type: NodeType,
  attrs: Attrs | null,
): boolean {
  if (canBecome(tr.doc, blockPos, type)) return convert(tr, blockPos, type, attrs);
  if (!isItemText(tr.doc, blockPos)) return false;
  const lifted = liftListItemOut(tr, tr.doc.resolve(blockPos).before());
  if (lifted === null) return false;
  if (canBecome(tr.doc, lifted.from, type)) return convert(tr, lifted.from, type, attrs);
  return false;
}

/** Inserts an empty code block at `pos` and puts the caret into it. */
function insertAt(tr: Transaction, pos: number, type: NodeType, attrs: Attrs | null): boolean {
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.canReplaceWith($pos.index(), $pos.index(), type)) return false;
  const code = type.createAndFill(attrs);
  if (code === null) return false;
  tr.insert(pos, code);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  return true;
}

/** An empty code block directly under the text block at `blockPos`. */
function insertAfter(
  tr: Transaction,
  blockPos: number,
  type: NodeType,
  attrs: Attrs | null,
): boolean {
  const block = tr.doc.nodeAt(blockPos);
  if (block === null) return false;
  return insertAt(tr, blockPos + block.nodeSize, type, attrs);
}

/**
 * The caret stands on an empty line of a text block that has other lines:
 * the line and its line break leave the block, and the code block stands
 * where the line stood. A line in the middle splits the block in two; a last
 * line puts the code block under it, a first line above it where the
 * container allows, else under it.
 */
function replaceEmptyLine(
  tr: Transaction,
  blockPos: number,
  line: { from: number; to: number },
  type: NodeType,
  attrs: Attrs | null,
): boolean {
  const block = tr.doc.nodeAt(blockPos);
  if (block === null) return false;
  const size = block.content.size;
  const cutFrom = line.from > 0 ? line.from - 1 : line.from;
  const cutTo = line.to < size ? line.to + 1 : line.to;
  const contentStart = blockPos + 1;
  tr.delete(contentStart + cutFrom, contentStart + cutTo);
  // A block that held nothing but this line and its break is an empty line.
  if (tr.doc.nodeAt(blockPos)?.content.size === 0) return replaceLine(tr, blockPos, type, attrs);

  if (cutFrom === 0) {
    // The first line: above the text, unless the text has to stay first.
    return isItemText(tr.doc, blockPos)
      ? insertAfter(tr, blockPos, type, attrs)
      : insertAt(tr, blockPos, type, attrs);
  }
  if (cutTo === size) return insertAfter(tr, blockPos, type, attrs);
  tr.split(contentStart + cutFrom);
  return insertAt(tr, contentStart + cutFrom + 1, type, attrs);
}

/**
 * A selection inside one text block: the selected text becomes the code
 * block, the text before stays in the block, the text after follows the code
 * block as a block of the same kind. A line break at either edge goes with
 * the cut, so neither half ends in an empty line.
 */
function extractSelection(
  tr: Transaction,
  blockPos: number,
  type: NodeType,
  attrs: Attrs | null,
): boolean {
  const probe = tr.doc;
  const contentStart = blockPos + 1;
  let midFrom = tr.selection.from;
  let midTo = tr.selection.to;
  if (isLineBreak(probe.nodeAt(midTo))) tr.delete(midTo, midTo + 1);
  if (midFrom > contentStart && isLineBreak(probe.resolve(midFrom).nodeBefore)) {
    tr.delete(midFrom - 1, midFrom);
    midFrom -= 1;
    midTo -= 1;
  }
  const currentEnd = tr.doc.resolve(contentStart).end();
  if (midTo < currentEnd) tr.split(midTo);
  // The text before keeps the block. When there is none and the block may not
  // turn into code where it stands (a list item's text), it stays as an empty
  // line rather than the code block standing before the item's own line.
  const splitFront = midFrom > contentStart || !canBecome(tr.doc, blockPos, type);
  let codePos = blockPos;
  if (splitFront) {
    tr.split(midFrom);
    codePos = midFrom + 1;
  }
  return canBecome(tr.doc, codePos, type) && convert(tr, codePos, type, attrs);
}
