import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    savedQueryEmbed: {
      /** Inserts a live answer to an existing saved query. */
      insertSavedQueryEmbed: (savedQueryId: string, name: string, limit: number) => ReturnType;
    };
  }
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Rows a block shows before it says "und mehr". Deliberately small. */
export const DEFAULT_QUERY_BLOCK_LIMIT = 5;

function limitAttribute(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_QUERY_BLOCK_LIMIT;
  return Math.min(Math.trunc(parsed), 50);
}

/**
 * A query block (issue #74): the answer to a saved query, inside a page.
 *
 * The third of the three surfaces on one query model, and the one that makes
 * the model worth having: a project page can carry "everything open in this
 * area" without anybody maintaining the list. What the node stores is only the
 * id of the question plus the name it had when it was inserted, exactly the
 * way `databaseEmbed` stores a database id and a title: the answer is fetched
 * when the block is rendered, never written into the document, because a
 * written answer is a copy that rots.
 *
 * Like `databaseEmbed`, the interactive rendering lives in `apps/web` as a
 * React node view; this node owns the schema only. The name is frozen at
 * insertion so headless rendering, search indexing and Markdown export have
 * something to say without a live fetch.
 */
export const SavedQueryEmbed = Node.create({
  name: 'savedQueryEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      savedQueryId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-saved-query-id') ?? '',
        renderHTML: (attributes) => ({
          'data-saved-query-id': stringAttribute(attributes.savedQueryId),
        }),
      },
      name: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-name') ?? '',
        renderHTML: (attributes) => ({ 'data-name': stringAttribute(attributes.name) }),
      },
      limit: {
        default: DEFAULT_QUERY_BLOCK_LIMIT,
        parseHTML: (element) => limitAttribute(element.getAttribute('data-limit')),
        renderHTML: (attributes) => ({ 'data-limit': String(limitAttribute(attributes.limit)) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-saved-query-embed]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const name = stringAttribute(node.attrs.name);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-saved-query-embed': '',
        class: 'exocortex-saved-query-embed',
      }),
      name.length > 0 ? name : 'Gespeicherte Suche',
    ];
  },

  addCommands() {
    return {
      insertSavedQueryEmbed:
        (savedQueryId: string, name: string, limit: number) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { savedQueryId, name, limit: limitAttribute(limit) },
          }),
    };
  },
});

function nameOf(attrs: Record<string, unknown> | undefined): string {
  return stringAttribute(attrs?.name);
}

export const savedQueryEmbedMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    savedQueryEmbed: (node, context) =>
      `:::saved-query ${nameOf(node.attrs)}${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    'saved-query': (params, context) => {
      // The id cannot be recovered from a name, the same way a database embed
      // cannot be recovered from its title: the block comes back empty and
      // asks which saved query it meant.
      context.addNode('savedQueryEmbed', {
        name: params,
        savedQueryId: '',
        limit: DEFAULT_QUERY_BLOCK_LIMIT,
      });
      return 0;
    },
  },
};

export const savedQueryEmbedPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    savedQueryEmbed: (node) => `${nameOf(node.attrs)}\n`,
  },
};

export const savedQueryEmbedBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'saved-query',
    label: 'Gespeicherte Suche einbetten',
    description: 'Lebende Trefferliste einer gespeicherten Suche in dieser Seite',
    keywords: ['suche', 'query', 'gespeichert', 'smart', 'view', 'liste', 'filter', 'dynamisch'],
    group: 'advanced',
    icon: 'ListFilter',
    prompt: 'saved-query',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      const picked = JSON.parse(value) as { savedQueryId: string; name: string; limit?: number };
      return editor
        .chain()
        .focus()
        .insertSavedQueryEmbed(
          picked.savedQueryId,
          picked.name,
          picked.limit ?? DEFAULT_QUERY_BLOCK_LIMIT,
        )
        .run();
    },
    isActive: (editor) => editor.isActive('savedQueryEmbed'),
  },
];
