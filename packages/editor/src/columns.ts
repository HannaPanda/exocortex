import { mergeAttributes, Node } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type EditorState } from '@tiptap/pm/state';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 5;
const DEFAULT_COLUMNS = 2;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Inserts a column layout with `count` empty columns. */
      insertColumns: (count?: number) => ReturnType;
      /** Adds a column to the layout the cursor is in. */
      addColumn: () => ReturnType;
      /** Removes the column the cursor is in, lifting its content out. */
      removeColumn: () => ReturnType;
    };
  }
}

/**
 * Side-by-side columns (Notion's "Spalten").
 *
 * Two nodes rather than one: the layout owns how many columns there are, each
 * column owns its own block content. That is what lets a column contain anything
 * a page can contain, including another layout.
 *
 * The widths are equal and are not stored. A stored per-column width would be a
 * layout decision frozen into the document, and it would have to be renegotiated
 * on every screen size; the reading measure from DESIGN.md already caps the
 * available width.
 */
export const ColumnList = Node.create({
  name: 'columnList',
  group: 'block',
  content: 'column{2,}',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-columns]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-columns': '', class: 'exocortex-columns' }),
      0,
    ];
  },

  addCommands() {
    return {
      insertColumns:
        (count = DEFAULT_COLUMNS) =>
        ({ commands }) => {
          const columns = Math.min(Math.max(count, MIN_COLUMNS), MAX_COLUMNS);
          return commands.insertContent({
            type: this.name,
            content: Array.from({ length: columns }, () => ({
              type: 'column',
              content: [{ type: 'paragraph' }],
            })),
          });
        },
      addColumn:
        () =>
        ({ state, chain }) => {
          const layout = findAncestor(state, this.name);
          if (layout === null) return false;
          if (layout.node.childCount >= MAX_COLUMNS) return false;
          return chain()
            .insertContentAt(layout.pos + layout.node.nodeSize - 1, {
              type: 'column',
              content: [{ type: 'paragraph' }],
            })
            .run();
        },
      removeColumn:
        () =>
        ({ state, chain }) => {
          const layout = findAncestor(state, this.name);
          const column = findAncestor(state, 'column');
          if (layout === null || column === null) return false;
          // Dropping below two columns would leave an invalid layout, so the
          // whole layout is lifted instead.
          if (layout.node.childCount <= MIN_COLUMNS) {
            return chain().lift(this.name).run();
          }
          return chain()
            .deleteRange({ from: column.pos, to: column.pos + column.node.nodeSize })
            .run();
        },
    };
  },
});

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-column]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-column': '', class: 'exocortex-column' }),
      0,
    ];
  },
});

/** Nearest ancestor of `typeName` around the selection, or `null`. */
function findAncestor(state: EditorState, typeName: string): { node: PmNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === typeName) return { node, pos: $from.before(depth) };
  }
  return null;
}

export const COLUMN_EXTENSIONS = [ColumnList, Column];

/**
 * Markdown adapter. Columns nest, so the outer container uses a longer marker
 * than the inner ones, exactly like nested code fences.
 */
export const columnsMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    columnList: (node, context) => {
      const columns = (node.content ?? [])
        .map((column) => {
          const body = context.renderBlockChildren(column).replace(/\n+$/, '');
          return `:::column\n${body}\n:::`;
        })
        .join('\n');
      return `::::columns${context.blockIdSuffix(node)}\n${columns}\n::::\n\n`;
    },
    column: (node, context) => context.renderBlockChildren(node),
  },
  containers: {
    columns: (_params, context) => {
      context.openNode('columnList');
      return 1;
    },
    column: (_params, context) => {
      context.openNode('column');
      return 1;
    },
  },
};

export const columnsPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    columnList: (node, renderChildren) => renderChildren(node),
    column: (node, renderChildren) => renderChildren(node),
  },
};

export const columnBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'columns',
    label: 'Spalten',
    description: 'Inhalte nebeneinander anordnen',
    keywords: ['spalten', 'columns', 'nebeneinander', 'layout', 'raster'],
    group: 'advanced',
    icon: 'Columns2',
    prompt: 'none',
    turnInto: false,
    run: (editor) => editor.chain().focus().insertColumns(2).run(),
    isActive: (editor) => editor.isActive('columnList'),
  },
];
