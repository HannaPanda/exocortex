import { type Editor } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, type Selection, TextSelection } from '@tiptap/pm/state';

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
