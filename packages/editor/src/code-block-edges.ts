import { type Node as PmNode, type NodeType, type ResolvedPos } from '@tiptap/pm/model';
import {
  type EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';

/**
 * Backspace and Delete at the edge of a code block (issue #319).
 *
 * ProseMirror's `joinBackward` and `joinForward` treat a code block like any
 * other text block: they join it with its neighbour. A code block holds its
 * lines as `\n` in one text node, so the join turned those lines into line
 * breaks of the paragraph above (through the schema's
 * `linebreakReplacement`), and the block was gone. After a list the code
 * landed in the last point as raw newlines, after a callout it moved into the
 * callout, after a picture the picture was deleted, and at the very start of
 * the page Tiptap's `clearNodes` turned the block into a paragraph holding
 * those newlines. The other way round, the text below a code block was pulled
 * into the code. Deleting the empty lines above a code block from its first
 * character therefore broke the block the moment the last one was gone.
 *
 * The rule, as Notion keeps it: **a code block is never joined with a
 * neighbour by Backspace or Delete.** Between a code block and the block next
 * to it, one key removes at most one empty line; otherwise the caret moves,
 * and nothing changes type.
 *
 * - Backspace at the start of an empty code block makes it an empty paragraph,
 *   wherever it stands (also inside a list item, issue #318).
 * - Backspace at the start of a code block with code in it: an empty line
 *   directly above goes, and the block moves up into it. Otherwise the caret
 *   goes to the end of the block above (the last point of a list, the last
 *   line of a callout), or that block is selected when it has no text (a
 *   picture, an embed). At the start of the page, or of a column or a table
 *   cell, nothing happens.
 * - Backspace in an empty line above a code block removes that line and
 *   nothing else (ProseMirror's own join does that once a block stands above
 *   the line; at the top of the page, where it did nothing, the line goes and
 *   the block moves up into it).
 * - Backspace at the start of the line below a code block: an empty line goes
 *   and the caret lands at the end of the code; a line with text keeps its
 *   text and the caret moves to the end of the code.
 * - Delete at the end of the line above a code block: an empty line goes and
 *   the caret lands at the start of the code; a line with text, or the last
 *   point of a list above the block, stays as it is.
 * - Delete at the end of a code block: an empty line directly below goes, a
 *   picture below is selected, anything else stays.
 *
 * Each outcome is one transaction, so `Strg+Z` takes it back in one step.
 * `null` means the rule has nothing to say and the key goes on to the next
 * handler; `'stay'` means it is handled and nothing changes.
 */
export type CodeBlockEdgeOutcome = Transaction | 'stay' | null;

function caretOf(state: EditorState): ResolvedPos | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  return $from.depth === 0 ? null : $from;
}

function isEmptyParagraph(node: PmNode | null | undefined): boolean {
  return node?.type.name === 'paragraph' && node.content.size === 0;
}

/**
 * Whether `$pos` is the first (`dir < 0`) or last (`dir > 0`) position of an
 * isolating block (a column, a table cell): the edge a key must not cross.
 */
function atIsolatingEdge($pos: ResolvedPos, depth: number, dir: -1 | 1): boolean {
  for (let level = depth; level > 0; level -= 1) {
    const parent = $pos.node(level - 1);
    const index = $pos.index(level - 1);
    const atEdge = dir < 0 ? index === 0 : index === parent.childCount - 1;
    if (!atEdge) return false;
    if (parent.type.spec.isolating === true) return true;
  }
  return false;
}

/**
 * The node directly before (`dir < 0`) or after (`dir > 0`) the text block
 * around `$pos`, climbing out of the containers it starts or ends, the way
 * ProseMirror finds where to join; `null` at the edge of the document.
 */
function neighbourAcross(
  $pos: ResolvedPos,
  dir: -1 | 1,
): { node: PmNode; depth: number; pos: number } | null {
  for (let depth = $pos.depth - 1; depth >= 0; depth -= 1) {
    const parent = $pos.node(depth);
    const index = $pos.index(depth);
    if (parent.type.spec.isolating === true && depth > 0) {
      const atEdge = dir < 0 ? index === 0 : index === parent.childCount - 1;
      if (atEdge) return null;
    }
    const neighbourIndex = index + dir;
    if (neighbourIndex < 0 || neighbourIndex >= parent.childCount) continue;
    const node = parent.child(neighbourIndex);
    const pos = dir < 0 ? $pos.before(depth + 1) - node.nodeSize : $pos.after(depth + 1);
    return { node, depth, pos };
  }
  return null;
}

/** `Backspace` with the caret at the start of a code block. */
function backspaceInCodeBlock(
  state: EditorState,
  $caret: ResolvedPos,
  paragraph: NodeType,
): CodeBlockEdgeOutcome {
  const code = $caret.parent;
  const codePos = $caret.before();
  if (code.content.size === 0) {
    const container = $caret.node(-1);
    const index = $caret.index(-1);
    if (!container.canReplaceWith(index, index + 1, paragraph)) return null;
    // The same block, turned: it keeps its identifier.
    const blockId: unknown = code.attrs.blockId;
    return state.tr.setNodeMarkup(codePos, paragraph, { blockId }).scrollIntoView();
  }
  const container = $caret.node(-1);
  const index = $caret.index(-1);
  if (index > 0 && isEmptyParagraph(container.child(index - 1))) {
    if (container.canReplace(index - 1, index)) {
      const before = container.child(index - 1);
      return state.tr.delete(codePos - before.nodeSize, codePos).scrollIntoView();
    }
  }
  if (atIsolatingEdge($caret, $caret.depth, -1)) return 'stay';
  const target = Selection.findFrom(state.doc.resolve(codePos), -1);
  if (target === null) return 'stay';
  return state.tr.setSelection(target).scrollIntoView();
}

/** `Delete` with the caret at the end of a code block. */
function deleteInCodeBlock(state: EditorState, $caret: ResolvedPos): CodeBlockEdgeOutcome {
  const container = $caret.node(-1);
  const index = $caret.index(-1);
  if (index + 1 >= container.childCount) return 'stay';
  const after = container.child(index + 1);
  const afterPos = $caret.after();
  if (isEmptyParagraph(after) && container.canReplace(index + 1, index + 2)) {
    return state.tr.delete(afterPos, afterPos + after.nodeSize).scrollIntoView();
  }
  if (!after.isTextblock && after.isAtom && NodeSelection.isSelectable(after)) {
    return state.tr.setSelection(NodeSelection.create(state.doc, afterPos)).scrollIntoView();
  }
  return 'stay';
}

/**
 * `Backspace` in an empty first line of the page with a code block below it:
 * the line goes and the block moves up into it. Elsewhere an empty line has a
 * block before it to go to, and ProseMirror's own join already removes it.
 */
function emptyFirstLineAbove(
  state: EditorState,
  $caret: ResolvedPos,
  codeBlock: NodeType,
): CodeBlockEdgeOutcome {
  if ($caret.depth !== 1 || !isEmptyParagraph($caret.parent)) return null;
  const doc = $caret.node(0);
  if (doc.childCount < 2 || doc.child(1).type !== codeBlock) return null;
  if (!doc.canReplace(0, 1)) return null;
  const tr = state.tr.delete($caret.before(), $caret.after());
  return tr.setSelection(TextSelection.create(tr.doc, 1)).scrollIntoView();
}

/**
 * What `Backspace` does at a code block's edge: the caret at the start of a
 * code block, or at the start of the text block right below one.
 */
export function codeBlockBackspace(state: EditorState, codeBlock: NodeType): CodeBlockEdgeOutcome {
  const $caret = caretOf(state);
  if ($caret === null || $caret.parentOffset !== 0) return null;
  const paragraph = state.schema.nodes.paragraph;
  if (paragraph === undefined) return null;
  if ($caret.parent.type === codeBlock) return backspaceInCodeBlock(state, $caret, paragraph);
  if (!$caret.parent.isTextblock) return null;
  const container = $caret.node(-1);
  const index = $caret.index(-1);
  const before = index > 0 ? container.child(index - 1) : null;
  if (before === null) return emptyFirstLineAbove(state, $caret, codeBlock);
  if (before.type !== codeBlock) return null;
  const lineStart = $caret.before();
  const codeEnd = lineStart - 1;
  const tr = state.tr;
  if ($caret.parent.content.size === 0 && container.canReplace(index, index + 1)) {
    tr.delete(lineStart, $caret.after());
  }
  return tr.setSelection(TextSelection.create(tr.doc, codeEnd)).scrollIntoView();
}

/**
 * What `Delete` does at a code block's edge: the caret at the end of a code
 * block, or at the end of the text right above one, also the last point of a
 * list or callout standing above it.
 */
export function codeBlockDelete(state: EditorState, codeBlock: NodeType): CodeBlockEdgeOutcome {
  const $caret = caretOf(state);
  if ($caret === null || $caret.parentOffset !== $caret.parent.content.size) return null;
  if ($caret.parent.type === codeBlock) return deleteInCodeBlock(state, $caret);
  if (!$caret.parent.isTextblock) return null;
  const neighbour = neighbourAcross($caret, 1);
  if (neighbour?.node.type !== codeBlock) return null;
  const direct = neighbour.depth === $caret.depth - 1;
  if (direct && $caret.parent.content.size === 0) {
    const container = $caret.node(-1);
    const index = $caret.index(-1);
    if (container.canReplace(index, index + 1)) {
      const lineStart = $caret.before();
      const tr = state.tr.delete(lineStart, $caret.after());
      return tr.setSelection(TextSelection.create(tr.doc, lineStart + 1)).scrollIntoView();
    }
  }
  return 'stay';
}
