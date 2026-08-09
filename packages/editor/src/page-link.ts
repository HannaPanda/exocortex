import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';
import { WIKI_LINK_SCHEME } from './markdown/serialize';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageLink: {
      /** Inserts a block that links to another page. */
      insertPageLink: (attributes: PageLinkAttributes) => ReturnType;
    };
  }
}

/** What a page link points at: an identity, plus the title that is shown. */
export interface PageLinkAttributes {
  /**
   * Title of the target as it was when the link was made. Display and export
   * only — never the identity. It is what an unresolved link still shows and
   * what `[[Titel]]` is written from.
   */
  title: string;
  /**
   * Identity of the target document. `null` for a link typed as a title that
   * no page carries (yet), and for links imported from Markdown, where the
   * application binds the identity afterwards (`bindPageLinkIdentities`).
   */
  documentId?: string | null;
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The stored identity, or `null` when the link only carries a title. */
export function pageLinkDocumentId(attrs: Record<string, unknown> | undefined): string | null {
  const value = attrs?.documentId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The stored display title. */
export function pageLinkTitle(attrs: Record<string, unknown> | undefined): string {
  return stringAttribute(attrs?.title);
}

/**
 * Link to another page as its own block (Notion's "Link zu einer Seite").
 *
 * Targets a page by **identity**: `documentId` is what the link means, so
 * renaming the target keeps every reference to it intact. The `title` rides
 * along as the label — it is what is displayed while the target is being
 * looked up, what an unresolved link still names, and what the Markdown layer
 * writes as `[[Seite]]`.
 *
 * `[[Titel]]` therefore stays a pure *interchange* format: an exported file
 * contains no internal identifiers, exactly as before, and an imported one is
 * bound back to identities by the application (`page-link-identity.ts`). The
 * same split the inline `mention` node already uses, where `id` is the
 * resolution hint next to the visible `label`.
 *
 * Resolution to a document happens where it always happened, in the
 * application, not in the schema — see `resolvePageLinkTarget` for the rule
 * and `apps/web/src/components/editor/page-link-node-view.tsx` for the UI.
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
          'data-page-title': stringAttribute(attributes.title),
        }),
      },
      documentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-document-id'),
        renderHTML: (attributes) => {
          const documentId = pageLinkDocumentId(attributes);
          return documentId === null ? {} : { 'data-document-id': documentId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-page-link]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const title = pageLinkTitle(node.attrs);
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-page-link': '',
        class: 'exocortex-page-link',
        // Still the `wiki:` address: exported HTML and the read-only view must
        // stay readable without the application resolving anything first.
        href: `${WIKI_LINK_SCHEME}${title}`,
      }),
      title,
    ];
  },

  addCommands() {
    return {
      insertPageLink:
        (attributes: PageLinkAttributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { title: attributes.title, documentId: attributes.documentId ?? null },
          }),
    };
  },
});

/**
 * Reads what the block prompt collected.
 *
 * The block catalog can only hand `run` a string, so the page picker encodes
 * its choice as JSON, exactly like the database picker. A bare string is still
 * accepted and means "this title, no identity" — that is what typing a title
 * for a page that does not exist yet produces.
 */
export function parsePageLinkPromptValue(value: string): PageLinkAttributes | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('{')) return { title: trimmed, documentId: null };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const title = stringAttribute(record.title).trim();
    if (title.length === 0) return null;
    return { title, documentId: pageLinkDocumentId(record) };
  } catch {
    // Not JSON after all: treat the whole thing as a title rather than lose it.
    return { title: trimmed, documentId: null };
  }
}

export const pageLinkMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    // Identity is deliberately not written: `[[Titel]]` / `:::page Titel` is an
    // interchange format and stays free of internal identifiers.
    pageLink: (node, context) =>
      `:::page ${pageLinkTitle(node.attrs)}${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    page: (params, context) => {
      // No identity in the file, so none here. `bindPageLinkIdentities` maps
      // the title back onto a document where the importer has a workspace.
      context.addNode('pageLink', { title: params, documentId: null });
      return 0;
    },
  },
};

export const pageLinkPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    pageLink: (node) => `${pageLinkTitle(node.attrs)}\n`,
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
      if (value === undefined) return false;
      const attributes = parsePageLinkPromptValue(value);
      if (attributes === null) return false;
      return editor.chain().focus().insertPageLink(attributes).run();
    },
    isActive: (editor) => editor.isActive('pageLink'),
  },
];
