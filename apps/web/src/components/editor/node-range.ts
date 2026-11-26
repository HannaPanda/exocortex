import { isNodeRangeSelection, NodeRange } from '@tiptap/extension-node-range';

/**
 * The drag handle's node range, without taking over text selection (issue #251).
 *
 * `NodeRange` is here because the drag handle needs it to grab a block. Its own
 * keymap also bound `Shift+ArrowUp` and `Shift+ArrowDown` unconditionally: the
 * first press turned any text selection into a selection of whole blocks,
 * anchored at the start of the paragraph the caret was in. Selecting the rest
 * of a line, or three lines of a paragraph, with the keyboard was impossible.
 *
 * The keys now extend a block range only when there already is one (the
 * handle made it, or a mouse drag with `Strg` did); everywhere else they are
 * left to the browser, which is the ordinary text selection every other editor
 * has. Its `Mod-a` binding is dropped too: select all belongs to
 * `ScopedSelectAll` and the core keymap, and the binding never ran anyway.
 */
export const BlockNodeRange = NodeRange.extend({
  addKeyboardShortcuts() {
    return {
      'Shift-ArrowUp': ({ editor }) => {
        const { selection } = editor.state;
        if (!isNodeRangeSelection(selection)) return false;
        editor.view.dispatch(editor.state.tr.setSelection(selection.extendBackwards()));
        return true;
      },
      'Shift-ArrowDown': ({ editor }) => {
        const { selection } = editor.state;
        if (!isNodeRangeSelection(selection)) return false;
        editor.view.dispatch(editor.state.tr.setSelection(selection.extendForwards()));
        return true;
      },
    };
  },
});
