import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * The hint in the empty line being written in (issue #227).
 *
 * „Schreibe etwas oder tippe „/“ für Befehle …“ tells a new reader that `/`
 * exists. It is a node decoration and nothing else: a class and an attribute
 * on the paragraph, drawn by the web app's stylesheet as `::before`, so it
 * never reaches the Yjs state, the text, the clipboard or the search index.
 *
 * It replaces Tiptap's `Placeholder`, which left hints behind. That extension
 * keeps its decorations in a state field and, to save work, recomputes only the
 * top-level blocks a transaction touched; the range it clears is one position
 * short, so the decoration of a top-level line the caret left was never
 * removed. Every empty line passed through kept the hint (the "Geist"), while
 * inside a list, one level down, the same code happened to work. Here nothing
 * is kept between transactions: the decoration is derived from the state every
 * time, which is at most one node and costs a position lookup, so no edit, no
 * paste, no undo and no change from another tab can leave a stale one.
 *
 * Where it stands, each rule deliberate:
 *
 * - Only in the paragraph the caret is in, and only while the caret is
 *   collapsed: a line inside a selection is not being written in.
 * - Only while the paragraph is really empty. A hard break, a formula or a
 *   mention is content, so the hint goes the moment one is there.
 * - Only while the editor has the focus. A hint left in an empty list point
 *   after the reader clicked elsewhere is what read like a real entry (the
 *   other half of the issue). The one exception is a page that is nothing but
 *   one empty line: that is an invitation to start, focus or not.
 * - Only while the page can be written.
 *
 * The class (`is-empty`) and the attribute (`data-placeholder`) stay Tiptap's,
 * because the list continuation of issue #240 swaps the text through them.
 */
export const linePlaceholderKey = new PluginKey('linePlaceholder');

/** The class the empty line carries, and the attribute holding the hint. */
export const LINE_PLACEHOLDER_CLASS = 'is-empty';
export const LINE_PLACEHOLDER_ATTRIBUTE = 'data-placeholder';

/** Whether the whole page is a single empty paragraph. */
function isEmptyPage(doc: PmNode): boolean {
  const only = doc.firstChild;
  return doc.childCount === 1 && only !== null && isEmptyParagraph(only);
}

function isEmptyParagraph(node: PmNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

/**
 * The position of the paragraph that shows the hint, or `null` for none.
 * `focused` is the editor's focus; a question of the view, so the caller asks
 * it and this stays testable without one.
 */
export function linePlaceholderPosition(state: EditorState, focused: boolean): number | null {
  const { selection, doc } = state;
  if (!selection.empty) return null;
  const $head = selection.$head;
  if ($head.depth === 0 || !isEmptyParagraph($head.parent)) return null;
  if (!focused && !isEmptyPage(doc)) return null;
  return $head.before();
}

export interface LinePlaceholderOptions {
  /**
   * The hint, in the reader's language. The page editor reads it from the
   * `editor` message namespace; this package keeps no interface text of its
   * own here, so without it the line is marked but says nothing.
   */
  placeholder: string;
}

export const LinePlaceholder = Extension.create<LinePlaceholderOptions>({
  name: 'linePlaceholder',

  addOptions() {
    return { placeholder: '' };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const placeholder = this.options.placeholder;
    return [
      new Plugin({
        key: linePlaceholderKey,
        props: {
          // Read on every update. Tiptap dispatches a transaction on focus and
          // on blur, which is what redraws the hint when the focus moves.
          decorations: (state) => {
            if (!editor.isEditable) return DecorationSet.empty;
            const pos = linePlaceholderPosition(state, editor.isFocused);
            if (pos === null) return DecorationSet.empty;
            const node = state.doc.nodeAt(pos);
            if (node === null) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + node.nodeSize, {
                class: LINE_PLACEHOLDER_CLASS,
                [LINE_PLACEHOLDER_ATTRIBUTE]: placeholder,
              }),
            ]);
          },
        },
      }),
    ];
  },
});
