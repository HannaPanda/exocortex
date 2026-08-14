import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    databaseEmbed: {
      /** Inserts a live, interactive view of an existing database. */
      insertDatabaseEmbed: (documentId: string, title: string) => ReturnType;
    };
  }
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Embeds a database (a `Document` with `type: 'COLLECTION'`) as a live view
 * inside another page (Notion's "linked database view").
 *
 * Unlike every other node in this package, its interactive rendering lives in
 * `apps/web` (a real React node view wrapping `DatabaseShell`), not here —
 * see `docs/editor-extensions.md`. This node only owns the schema: which
 * database, which view, and the title frozen at selection time for headless
 * rendering, search and Markdown export, none of which can afford a live
 * fetch. `documentId` is the canonical reference used by the live view; it is
 * intentionally never written to Markdown (see `databaseEmbedMarkdownAdapter`
 * below), matching `pageLink`'s title-only interchange format.
 */
export const DatabaseEmbed = Node.create({
  name: 'databaseEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      documentId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-document-id') ?? '',
        renderHTML: (attributes) => ({
          'data-document-id': stringAttribute(attributes.documentId),
        }),
      },
      viewId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-view-id'),
        renderHTML: (attributes) => {
          const value = attributes.viewId;
          return typeof value === 'string' && value.length > 0 ? { 'data-view-id': value } : {};
        },
      },
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-title') ?? '',
        renderHTML: (attributes) => ({ 'data-title': stringAttribute(attributes.title) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-database-embed]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const title = stringAttribute(node.attrs.title);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-database-embed': '',
        class: 'exocortex-database-embed',
      }),
      title.length > 0 ? title : 'Datenbank',
    ];
  },

  addCommands() {
    return {
      insertDatabaseEmbed:
        (documentId: string, title: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { documentId, title, viewId: null } }),
    };
  },
});

function titleOf(attrs: Record<string, unknown> | undefined): string {
  return stringAttribute(attrs?.title);
}

export const databaseEmbedMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    databaseEmbed: (node, context) =>
      `:::database-embed ${titleOf(node.attrs)}${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    'database-embed': (params, context) => {
      // The id cannot be recovered from a title (see the module doc); the
      // embed reopens its database picker the next time it is rendered.
      context.addNode('databaseEmbed', { title: params, documentId: '', viewId: null });
      return 0;
    },
  },
};

export const databaseEmbedPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    databaseEmbed: (node) => `${titleOf(node.attrs)}\n`,
  },
};

export const databaseEmbedBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'database-embed',
    label: 'Datenbank einbetten',
    description: 'Ansicht einer bestehenden Datenbank direkt in dieser Seite',
    keywords: ['datenbank', 'database', 'ansicht', 'view', 'embed', 'tabelle', 'verknüpft'],
    group: 'advanced',
    icon: 'LayoutGrid',
    prompt: 'database',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      const picked = JSON.parse(value) as { documentId: string; title: string };
      return editor.chain().focus().insertDatabaseEmbed(picked.documentId, picked.title).run();
    },
    isActive: (editor) => editor.isActive('databaseEmbed'),
  },
];
