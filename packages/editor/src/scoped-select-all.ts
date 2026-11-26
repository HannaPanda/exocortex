import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';

/**
 * Blocks with a text of their own, which `Strg+A` selects before the page.
 *
 * A code block above all: it is where a writer reaches for `Strg+A` out of
 * habit from every code editor, and before issue #261 the keystroke selected
 * the whole page, so the next key replaced it. The containers follow the same
 * rule because the same habit applies to a table cell, a callout and a quote.
 * A plain paragraph is deliberately not a scope: `Strg+A` in running text
 * means the page, as it always has.
 */
export const SELECT_ALL_SCOPE_NODES: ReadonlySet<string> = new Set([
  'codeBlock',
  'tableCell',
  'tableHeader',
  'callout',
  'blockquote',
]);

/** The text range `Strg+A` selects for one enclosing block. */
interface SelectAllScope {
  /** Position directly before the block; identifies it while nothing moves. */
  pos: number;
  from: number;
  to: number;
}

const scopedSelectAllKey = new PluginKey<number | null>('exocortexScopedSelectAll');

/** The selectable text inside a block: its whole content for a code block,
 *  from the first to the last text position for a container. */
function textRange(doc: PmNode, node: PmNode, start: number, end: number): [number, number] | null {
  if (node.isTextblock) return [start, end];
  const first = Selection.findFrom(doc.resolve(start), 1, true);
  const last = Selection.findFrom(doc.resolve(end), -1, true);
  if (first === null || last === null || first.from > last.to) return null;
  if (first.from < start || last.to > end) return null;
  return [first.from, last.to];
}

/** The scopes around the selection, innermost first. Both ends of the
 *  selection have to lie in a block for it to count. */
function scopesAround(state: EditorState): SelectAllScope[] {
  const { $from, $to } = state.selection;
  const scopes: SelectAllScope[] = [];
  for (let depth = $from.sharedDepth($to.pos); depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (!SELECT_ALL_SCOPE_NODES.has(node.type.name)) continue;
    const range = textRange(state.doc, node, $from.start(depth), $from.end(depth));
    if (range === null) continue;
    scopes.push({ pos: $from.before(depth), from: range[0], to: range[1] });
  }
  return scopes;
}

/**
 * `Strg+A` (`Cmd+A`) widens one step at a time (issue #261): the first press
 * selects the text of the innermost code block, table cell, callout or quote
 * the caret is in, the next one the block around that, and only when there is
 * nothing narrower left does Tiptap's own select all take the page.
 *
 * A step counts as taken when the selection already covers the block's text.
 * An empty block covers nothing, so the plugin remembers which block the last
 * press selected; without that an empty code block would hand the very first
 * press to the page, which is the data loss this exists to prevent. Any
 * change to the document or the selection forgets it.
 *
 * Only the selection changes. Typing, cutting and pasting then act on that
 * range through the editor's ordinary paths, and undo restores it like any
 * other edit.
 */
export const ScopedSelectAll = Extension.create({
  name: 'scopedSelectAll',

  // Ahead of the core keymap, which binds `Mod-a` to `selectAll` at the
  // default priority.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: scopedSelectAllKey,
        state: {
          init: () => null,
          apply(tr, value, oldState) {
            const meta: unknown = tr.getMeta(scopedSelectAllKey);
            if (typeof meta === 'number') return meta;
            if (tr.docChanged || !tr.selection.eq(oldState.selection)) return null;
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
        const selected = scopedSelectAllKey.getState(state) ?? null;
        const { from, to } = state.selection;
        for (const scope of scopesAround(state)) {
          const covered =
            selected === scope.pos ||
            (scope.from < scope.to && from === scope.from && to === scope.to);
          if (covered) continue;
          view.dispatch(
            state.tr
              .setSelection(TextSelection.create(state.doc, scope.from, scope.to))
              .setMeta(scopedSelectAllKey, scope.pos)
              .scrollIntoView(),
          );
          return true;
        }
        return false;
      },
    };
  },
});
