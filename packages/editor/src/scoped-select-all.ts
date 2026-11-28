import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';

/**
 * Containers `Strg+A` selects as a whole before the page, after the text
 * block the caret is in.
 *
 * Every text block (paragraph, heading, list item text, task text, a toggle's
 * summary, a code block) is the first step on its own and is not listed here
 * (issue #263). These are the blocks around text that a writer means as one
 * thing: a list item together with the items nested under it, a toggle with
 * its summary and content, a column, a callout, a quote and a table cell.
 * The list itself is deliberately not a step: neither is it in Notion, and the
 * page after the item is one press away.
 */
export const SELECT_ALL_SCOPE_NODES: ReadonlySet<string> = new Set([
  'listItem',
  'taskItem',
  'details',
  'column',
  'callout',
  'blockquote',
  'tableCell',
  'tableHeader',
]);

/** The text range `Strg+A` selects for one enclosing block. */
interface SelectAllScope {
  from: number;
  to: number;
}

/** Whether the last press of `Strg+A` set the current selection. */
const scopedSelectAllKey = new PluginKey<boolean>('exocortexScopedSelectAll');

/** Whether `Strg+A` stops at this block. A closed toggle shows only its
 *  summary, which the step before already selected; widening into the hidden
 *  content would select text nobody sees, so it is passed over. */
function isScope(node: PmNode): boolean {
  if (node.isTextblock) return true;
  if (!SELECT_ALL_SCOPE_NODES.has(node.type.name)) return false;
  return !(node.type.name === 'details' && node.attrs.open === false);
}

/** The selectable text inside a block: its whole content for a text block,
 *  from the first to the last text position for a container. */
function textRange(doc: PmNode, node: PmNode, start: number, end: number): SelectAllScope | null {
  if (node.isTextblock) return { from: start, to: end };
  const first = Selection.findFrom(doc.resolve(start), 1, true);
  const last = Selection.findFrom(doc.resolve(end), -1, true);
  if (first === null || last === null || first.from > last.to) return null;
  if (first.from < start || last.to > end) return null;
  return { from: first.from, to: last.to };
}

/** The scopes around the selection, innermost first. Both ends of the
 *  selection have to lie in a block for it to count. */
function scopesAround(state: EditorState): SelectAllScope[] {
  const { $from, $to } = state.selection;
  const scopes: SelectAllScope[] = [];
  for (let depth = $from.sharedDepth($to.pos); depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!isScope(node)) continue;
    const range = textRange(state.doc, node, $from.start(depth), $from.end(depth));
    if (range !== null) scopes.push(range);
  }
  return scopes;
}

/**
 * `Strg+A` (`Cmd+A`) widens one step at a time, the way it does in Notion
 * (issues #261 and #263): the first press selects the text of the block the
 * caret is in, a paragraph, a heading, a list item's text or a code block,
 * even when it is empty. Every further press selects the next block around
 * it that holds more: a list item with the items nested under it, a toggle, a
 * column, a callout, a quote, a table cell. Only when there is nothing
 * narrower left does Tiptap's own select all take the page.
 *
 * A step counts as taken when the selection already covers the block's text,
 * whoever selected it: text selected with the mouse is a step done. A step
 * that would select exactly what is already selected (a list item without
 * nested items covers the same text as its line) is passed over, so every
 * press visibly widens. An empty block covers nothing, so the plugin
 * remembers that the last press set the selection; without that an empty
 * block would hand the very first press to the page, or keep selecting
 * itself. Any change to the document or the selection forgets it.
 *
 * Only the selection changes. Typing, cutting, copying and pasting then act
 * on that range through the editor's ordinary paths, and undo restores it like
 * any other edit.
 */
export const ScopedSelectAll = Extension.create({
  name: 'scopedSelectAll',

  // Ahead of the core keymap, which binds `Mod-a` to `selectAll` at the
  // default priority.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: scopedSelectAllKey,
        state: {
          init: () => false,
          apply(tr, value, oldState) {
            if (tr.getMeta(scopedSelectAllKey) === true) return true;
            if (tr.docChanged || !tr.selection.eq(oldState.selection)) return false;
            return value;
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-a': ({ editor }) => {
        const { state, view } = editor;
        const pressed = scopedSelectAllKey.getState(state) === true;
        const { from, to } = state.selection;
        for (const scope of scopesAround(state)) {
          const covered =
            from <= scope.from && to >= scope.to && (scope.from < scope.to || pressed);
          if (covered) continue;
          view.dispatch(
            state.tr
              .setSelection(TextSelection.create(state.doc, scope.from, scope.to))
              .setMeta(scopedSelectAllKey, true)
              .scrollIntoView(),
          );
          return true;
        }
        return false;
      },
    };
  },
});
