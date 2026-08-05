import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';
import { WIKI_LINK_SCHEME } from './markdown/serialize';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageLink: {
      /** Inserts a block that links to another page by title. */
      insertPageLink: (title: string) => ReturnType;
    };
  }
}

/**
 * Link to another page as its own block (Notion's "Link zu einer Seite").
 *
 * Targets a page by **title**, exactly like the `[[Seite]]` wiki link the Markdown
 * layer already understands, so both notations mean the same thing and an exported
 * file has no internal identifiers in it. Resolution to a document happens where
 * it always happens, in the application, not in the schema.
 */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-page-title') ?? '',
        renderHTML: (attributes) => ({
          'data-page-title': typeof attributes.title === 'string' ? attributes.title : '',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-page-link]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-page-link': '',
        class: 'exocortex-page-link',
        href: `${WIKI_LINK_SCHEME}${title}`,
      }),
      title,
    ];
  },

  addCommands() {
    return {
      insertPageLink:
        (title: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { title } }),
    };
  },
});

function titleOf(attrs: Record<string, unknown> | undefined): string {
  return typeof attrs?.title === 'string' ? attrs.title : '';
}

export const pageLinkMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    pageLink: (node, context) =>
      `:::page ${titleOf(node.attrs)}${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    page: (params, context) => {
      context.addNode('pageLink', { title: params });
      return 0;
    },
  },
};

export const pageLinkPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    pageLink: (node) => `${titleOf(node.attrs)}\n`,
  },
};

export const pageLinkBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'page-link',
    label: 'Seitenlink',
    description: 'Verweis auf eine andere Seite als eigener Block',
    keywords: ['seite', 'link', 'verweis', 'page', 'wiki', '[['],
    group: 'advanced',
    icon: 'Link2',
    prompt: 'page',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().insertPageLink(value).run();
    },
    isActive: (editor) => editor.isActive('pageLink'),
  },
];
