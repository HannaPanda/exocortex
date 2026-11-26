import { Extension } from '@tiptap/core';
import { type Node as PmNode, type ResolvedPos } from '@tiptap/pm/model';
import { type EditorState, Selection, TextSelection } from '@tiptap/pm/state';

/**
 * Whether a block is one the browser's caret cannot walk through: an image, a
 * file, a formula, an embed, a divider. They are drawn without editable text
 * (`contenteditable="false"` or a bare `<hr>`), and Chromium stops a growing
 * selection in front of them for good.
 */
function isOpaqueBlock(node: PmNode): boolean {
  return node.isBlock && !node.isTextblock && (node.isAtom || node.isLeaf);
}

/**
 * The outermost isolating block (a table, a column) around `$pos` that does not
 * also hold `anchor`, or `null`. A selection that starts outside a table and
 * reaches into it can only ever take the whole table: anything else is a
 * selection of half a grid, which neither the browser nor ProseMirror can draw.
 */
function foreignIsolatingAncestor(
  $pos: ResolvedPos,
  anchor: number,
): { before: number; after: number } | null {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.spec.isolating !== true) continue;
    const before = $pos.before(depth);
    const after = $pos.after(depth);
    if (anchor > before && anchor < after) continue;
    return { before, after };
  }
  return null;
}

/** Whether `$pos` lies inside any isolating block. */
function insideIsolating($pos: ResolvedPos): boolean {
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    if ($pos.node(depth).type.spec.isolating === true) return true;
  }
  return false;
}

/**
 * Where `Shift+Pfeil` should move the head of a text selection that sits at
 * the edge of its paragraph, or `null` to leave the key to the browser.
 *
 * The browser extends a selection natively, and that stays the rule: inside a
 * paragraph, across lists, quotes, callouts and code blocks it already does
 * what everybody expects. It fails at exactly two kinds of border (issue #251):
 * an opaque block (image, formula, divider, embed), where Chromium stops dead
 * or drops the anchor, and a table entered from outside, where the head lands
 * in a random cell and stays there. Only those two are taken over, and the
 * answer is the same one Firefox gives for the first: the head jumps to the
 * next text beyond, so the opaque block or the whole table is part of the
 * selection. The anchor never moves.
 *
 * `dir` is 1 for forward (right, down) and -1 for backward (left, up).
 */
export function shiftArrowTarget(state: EditorState, dir: 1 | -1): TextSelection | null {
  const { selection, doc } = state;
  if (!(selection instanceof TextSelection)) return null;
  const { $head, anchor } = selection;
  if (!$head.parent.inlineContent || $head.depth === 0) return null;
  // Moving between cells or columns is the table's and the browser's business.
  if (insideIsolating($head)) return null;

  let $start = doc.resolve(dir > 0 ? $head.after() : $head.before());
  let crossedTable = false;
  for (;;) {
    const next = Selection.findFrom($start, dir, true);
    if (next === null) return null;
    const foreign = foreignIsolatingAncestor(next.$head, anchor);
    if (foreign === null) {
      const from = Math.min($head.pos, next.head);
      const to = Math.max($head.pos, next.head);
      let opaque = false;
      doc.nodesBetween(from, to, (node) => {
        if (opaque) return false;
        if (isOpaqueBlock(node)) opaque = true;
        return !opaque;
      });
      if (!opaque && !crossedTable) return null;
      return TextSelection.create(doc, anchor, dir > 0 ? next.from : next.to);
    }
    crossedTable = true;
    $start = doc.resolve(dir > 0 ? foreign.after : foreign.before);
  }
}

/** Whether the head of the selection is at the edge of its paragraph in `dir`. */
function atTextblockEdge(state: EditorState, dir: 1 | -1): boolean {
  const { $head } = state.selection;
  if (!$head.parent.inlineContent) return false;
  return dir > 0 ? $head.parentOffset === $head.parent.content.size : $head.parentOffset === 0;
}

/**
 * `Shift+Pfeil` across images, formulas, dividers and tables (issue #251).
 *
 * Left and right are taken over at the edge of a paragraph only; up and down
 * only on its first or last visual line, which only the view can tell. Every
 * other press stays native, so word and line selection, `Shift+Pos1/Ende` and
 * the platform's own conventions are untouched. Behaviour only, no schema.
 */
export const ShiftArrowSelection = Extension.create({
  name: 'shiftArrowSelection',

  // Ahead of the table keymap, which reads a head in a cell as its own.
  priority: 1000,

  addKeyboardShortcuts() {
    const extend = (dir: 1 | -1, vertical: boolean): boolean => {
      const { state, view } = this.editor;
      // The document is asked first: only a paragraph next to an opaque block
      // or a table needs the layout measured, every other press stays cheap.
      const target = shiftArrowTarget(state, dir);
      if (target === null) return false;
      const atEdge = vertical
        ? view.endOfTextblock(dir > 0 ? 'down' : 'up')
        : atTextblockEdge(state, dir);
      if (!atEdge) return false;
      view.dispatch(state.tr.setSelection(target).scrollIntoView());
      return true;
    };
    return {
      'Shift-ArrowRight': () => extend(1, false),
      'Shift-ArrowLeft': () => extend(-1, false),
      'Shift-ArrowDown': () => extend(1, true),
      'Shift-ArrowUp': () => extend(-1, true),
    };
  },
});
