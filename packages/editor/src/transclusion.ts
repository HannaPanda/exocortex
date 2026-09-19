import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { isValidBlockId } from './block-id';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    transclusion: {
      /** Inserts a block that shows content owned by another page. */
      insertTransclusion: (attributes: TransclusionAttributes) => ReturnType;
    };
  }
}

/** What a transclusion points at: a page, optionally one block inside it. */
export interface TransclusionAttributes {
  /**
   * Identity of the source page. `null` for a reference imported from Markdown
   * before the application bound the title back to a document, exactly like
   * `pageLink`.
   */
  documentId?: string | null;
  /**
   * Title of the source as it was when the transclusion was made. Display and
   * export only -- never the identity. It is what an unresolved reference still
   * names and what `:::transclusion Titel` is written from.
   */
  label: string;
  /**
   * Identifier of the addressable block to show. `null` means the whole page.
   * A heading brings its section along; see `extractBlockFragment`.
   *
   * Named `sourceBlockId` because `blockId` is already taken on every
   * addressable node, including this one: that one says where *this* block
   * lives, this one says which block it shows.
   */
  sourceBlockId?: string | null;
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The stored identity, or `null` when the reference only carries a title. */
export function transclusionDocumentId(attrs: Record<string, unknown> | undefined): string | null {
  const value = attrs?.documentId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The addressed block of the source, or `null` for the whole page. */
export function transclusionBlockId(attrs: Record<string, unknown> | undefined): string | null {
  const value = attrs?.sourceBlockId;
  return isValidBlockId(value) ? value : null;
}

/** The stored display label. */
export function transclusionLabel(attrs: Record<string, unknown> | undefined): string {
  return stringAttribute(attrs?.label);
}

/**
 * Transclusion: content shown here, owned somewhere else (issue #78, ADR-045).
 *
 * The node stores a reference and nothing else. There is no copy of the source
 * text in this document -- not in the Yjs state, not in the ProseMirror JSON,
 * not in the plain text the search index is built from -- which is the whole
 * point: a status section that appears on a project page and on an overview
 * page is one section, and editing it in its one canonical place changes both.
 * A block that carried a copy would be a second original that rots, the same
 * mistake a query block avoids by storing the question instead of the answer
 * (ADR-042).
 *
 * What it looks like is therefore decided when somebody reads, by
 * `GET /api/documents/:id/fragment`, which runs as that reader. So the source's
 * permissions apply at the place of the embedding without this node knowing
 * anything about permissions, and a reader who may not open the source sees
 * that it is there rather than its content.
 *
 * `documentId` is the identity, `label` rides along as the name: renaming or
 * moving the source keeps every transclusion of it intact, and an exported file
 * still names it in words (`:::transclusion Titel^blockid`) rather than with an
 * internal id -- the split `pageLink` uses, for the same reason.
 *
 * As with `databaseEmbed` and `savedQueryEmbed`, the interactive rendering is a
 * React node view in `apps/web`; this node owns the schema only.
 */
export const Transclusion = Node.create({
  name: 'transclusion',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      documentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-document-id'),
        renderHTML: (attributes) => {
          const documentId = transclusionDocumentId(attributes);
          return documentId === null ? {} : { 'data-document-id': documentId };
        },
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? '',
        renderHTML: (attributes) => ({ 'data-label': stringAttribute(attributes.label) }),
      },
      sourceBlockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-source-block-id'),
        renderHTML: (attributes) => {
          const blockId = transclusionBlockId(attributes);
          return blockId === null ? {} : { 'data-source-block-id': blockId };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-transclusion]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = transclusionLabel(node.attrs);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-transclusion': '',
        class: 'exocortex-transclusion',
      }),
      label.length > 0 ? label : 'Eingebetteter Inhalt',
    ];
  },

  addCommands() {
    return {
      insertTransclusion:
        (attributes: TransclusionAttributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              documentId: attributes.documentId ?? null,
              label: attributes.label,
              sourceBlockId: attributes.sourceBlockId ?? null,
            },
          }),
    };
  },
});

/**
 * Writes the container parameter: the source's title, plus `^blockId` when the
 * reference names one block rather than the whole page.
 *
 * Obsidian's block address, and readable without this application: the file
 * says which page and which block, in the words a person would use.
 */
export function formatTransclusionParams(attrs: Record<string, unknown> | undefined): string {
  const blockId = transclusionBlockId(attrs);
  const label = transclusionLabel(attrs);
  return blockId === null ? label : `${label}^${blockId}`;
}

/** Reads back what `formatTransclusionParams` wrote. */
export function parseTransclusionParams(params: string): { label: string; blockId: string | null } {
  const trimmed = params.trim();
  const marker = trimmed.lastIndexOf('^');
  if (marker < 0) return { label: trimmed, blockId: null };

  const candidate = trimmed.slice(marker + 1);
  // A title may contain a caret. Only a suffix that really is a block
  // identifier is read as one; anything else stays part of the title.
  if (!isValidBlockId(candidate)) return { label: trimmed, blockId: null };
  return { label: trimmed.slice(0, marker).trim(), blockId: candidate };
}

/**
 * Reads what the block prompt collected.
 *
 * The catalog can only hand `run` a string, so the page picker encodes its
 * choice as JSON, exactly like the page link. A bare string means "this title,
 * no identity", which is what naming a page that does not exist yet produces.
 */
export function parseTransclusionPromptValue(value: string): TransclusionAttributes | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('{')) return { label: trimmed, documentId: null, sourceBlockId: null };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // The picker answers with the key a page reference uses everywhere else.
    const label = stringAttribute(record.title ?? record.label).trim();
    if (label.length === 0) return null;
    return {
      label,
      documentId: transclusionDocumentId(record),
      sourceBlockId: transclusionBlockId(record),
    };
  } catch {
    return { label: trimmed, documentId: null, sourceBlockId: null };
  }
}

export const transclusionMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    // The identity is deliberately not written, the same rule `pageLink`
    // follows: an exported file addresses the source by title and stays free of
    // internal document ids. The block identifier *is* written, because it is
    // the address of the part and nothing else names it.
    transclusion: (node, context) =>
      `:::transclusion ${formatTransclusionParams(node.attrs)}${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    transclusion: (params, context) => {
      const { label, blockId } = parseTransclusionParams(params);
      // No identity in the file, so none here. `bindPageLinkIdentities` maps
      // the title back onto a document where the importer has a workspace.
      context.addNode('transclusion', { label, documentId: null, sourceBlockId: blockId });
      return 0;
    },
  },
};

export const transclusionPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    /*
     * The label, never the source's text.
     *
     * The plain text of a page is what the search index and the embeddings are
     * built from, so rendering the transcluded content here would weigh one
     * paragraph once for the page that owns it and once more for every page
     * that shows it -- a passage embedded in five overview pages would beat the
     * page it belongs to. The reference is indexed; the content is indexed
     * where it lives.
     */
    transclusion: (node) => `${transclusionLabel(node.attrs)}\n`,
  },
};

export const transclusionBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'transclusion',
    label: 'Inhalt einbetten',
    description: 'Zeigt Text einer anderen Seite, ohne ihn zu kopieren',
    keywords: [
      'einbetten',
      'transklusion',
      'transclusion',
      'referenz',
      'block',
      'spiegel',
      'synchron',
      'embed',
      '!',
    ],
    group: 'advanced',
    icon: 'Blocks',
    prompt: 'page',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined) return false;
      const attributes = parseTransclusionPromptValue(value);
      if (attributes === null) return false;
      return editor.chain().focus().insertTransclusion(attributes).run();
    },
    isActive: (editor) => editor.isActive('transclusion'),
  },
];
