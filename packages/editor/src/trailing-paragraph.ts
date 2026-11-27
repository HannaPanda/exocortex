import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import {
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';

/**
 * A line to write in after the last block (issues #257 and #303).
 *
 * A page that ends in a picture, a table, a code block, a database, a PDF or
 * any other block that is not a paragraph left no place to keep writing: a
 * click below it selected the block or landed inside it, and the arrow keys
 * stopped there. A page that ends in a paragraph with text in it, a link or a
 * bare address for instance, left none either: a click below it only put the
 * caret behind the last character (issue #303). Now the space below the last
 * block is a line, and using it makes the paragraph there.
 *
 * The paragraph is made on use, never in advance. A plugin that keeps an empty
 * paragraph at the end of every document (Tiptap's `TrailingNode`) writes it
 * into the Yjs state the moment the page is opened, and that is exactly how
 * every visit once left a blank line behind: a write nobody made, merged with
 * the stored state by Yjs instead of replacing anything (see
 * `collaboration-connection.ts`). A gap cursor writes nothing either, but it
 * is a blinking bar rather than a line, it cannot stand after a code block or
 * a callout (both end in text), and the empty line below a list and a picture
 * is where the list's continuation is offered (issue #240), which needs a
 * real paragraph for the caret to stand in.
 *
 * So the line is drawn, not stored: while the page does not end in an empty
 * paragraph, the editor gets `data-trailing-line` and the web app's
 * stylesheet reserves one line of space below the last block. Two ways in,
 * both one transaction that appends one paragraph and puts the caret into it:
 *
 * - **A click** into the space below the last block, on the editor's own
 *   surface. On a short page that is all the empty canvas below the text.
 * - **Arrow down** from the bottom of the page: from a selected picture, embed
 *   or table cell in the last row, from the last line of the text the page
 *   ends in (a code block, a callout, a quote, the last point of a list), or
 *   from the end of the paragraph the page ends in, as long as nothing
 *   selectable follows.
 *
 * Once the page ends in an empty paragraph there is nothing left to do, so a
 * second click never makes a second line. A line made and left empty stays,
 * as one made with `Enter` would: it is a write somebody made.
 */
export const trailingParagraphKey = new PluginKey('trailingParagraph');

/** The attribute the editor carries while the page needs the line. */
export const TRAILING_LINE_ATTRIBUTE = 'data-trailing-line';

/**
 * Whether the page lacks an empty line at its end: it ends in a block that is
 * not a paragraph, or in a paragraph with something in it.
 */
export function needsTrailingParagraph(doc: PmNode): boolean {
  const last = doc.lastChild;
  if (last === null) return false;
  return last.type.name !== 'paragraph' || last.content.size > 0;
}

/** Whether nothing selectable follows `pos`: below it is the end of the page. */
function nothingAfter(doc: PmNode, pos: number): boolean {
  return Selection.findFrom(doc.resolve(pos), 1) === null;
}

/**
 * Whether `ArrowDown` from the current selection leaves the last block of the
 * page. `atBottomOfTextblock` is the view's answer to whether the caret sits
 * on the last line of its text (`endOfTextblock('down')`); it is a question of
 * layout, so the caller asks it and this stays testable without one.
 */
export function arrowDownLeavesPage(state: EditorState, atBottomOfTextblock: boolean): boolean {
  const { doc, selection } = state;
  if (!needsTrailingParagraph(doc)) return false;
  if (selection instanceof NodeSelection) return nothingAfter(doc, selection.to);
  if (!(selection instanceof TextSelection) || !selection.empty || !atBottomOfTextblock) {
    return false;
  }
  const $head = selection.$head;
  if (!$head.parent.isTextblock) return false;
  // Every cell of a table's last row is on the bottom line, not only the
  // last cell, so the row decides rather than the text after the caret.
  for (let depth = $head.depth; depth > 1; depth -= 1) {
    if ($head.node(depth).type.name !== 'tableRow') continue;
    const table = $head.node(depth - 1);
    return (
      $head.index(depth - 1) === table.childCount - 1 && nothingAfter(doc, $head.after(depth - 1))
    );
  }
  // In the paragraph the page ends in, arrow down on its last line first
  // does what it always did: it moves the caret to the end of that line. Only
  // from the end does it leave the paragraph (issue #303).
  if (
    $head.depth === 1 &&
    $head.parent.type.name === 'paragraph' &&
    $head.parentOffset < $head.parent.content.size
  ) {
    return false;
  }
  return nothingAfter(doc, $head.after());
}

/** Appends one empty paragraph to the page and puts the caret into it. */
export function appendTrailingParagraph(state: EditorState): Transaction {
  const end = state.doc.content.size;
  const tr = state.tr.insert(end, state.schema.node('paragraph'));
  return tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView();
}

export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: trailingParagraphKey,
        props: {
          attributes: (state): Record<string, string> =>
            needsTrailingParagraph(state.doc) ? { [TRAILING_LINE_ATTRIBUTE]: '' } : {},
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!view.editable || event.button !== 0) return false;
              if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
              // Only the editor's own surface: a click on a block, its
              // controls or a node view is that block's.
              if (event.target !== view.dom) return false;
              const { doc } = view.state;
              const last = doc.lastChild;
              if (last === null || !needsTrailingParagraph(doc)) return false;
              const lastDom = view.nodeDOM(doc.content.size - last.nodeSize);
              if (!(lastDom instanceof Element)) return false;
              if (event.clientY <= lastDom.getBoundingClientRect().bottom) return false;
              // Before the browser places a caret or takes the focus itself.
              event.preventDefault();
              view.dispatch(appendTrailingParagraph(view.state));
              view.focus();
              return true;
            },
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      ArrowDown: ({ editor }) => {
        if (!editor.isEditable) return false;
        const { view, state } = editor;
        // Asked first: the layout question below is the expensive one.
        if (!needsTrailingParagraph(state.doc)) return false;
        const textCaret = state.selection instanceof TextSelection && state.selection.empty;
        const atBottom = textCaret && view.endOfTextblock('down');
        if (!arrowDownLeavesPage(state, atBottom)) return false;
        view.dispatch(appendTrailingParagraph(state));
        return true;
      },
    };
  },
});
