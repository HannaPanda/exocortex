import { type Extensions, mergeAttributes } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { Document } from '@tiptap/extension-document';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Heading } from '@tiptap/extension-heading';
import { HorizontalRule } from '@tiptap/extension-horizontal-rule';
import { Image } from '@tiptap/extension-image';
import { Italic } from '@tiptap/extension-italic';
import { Link } from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Strike } from '@tiptap/extension-strike';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Text } from '@tiptap/extension-text';

import {
  type BlockCatalogEntry,
  calloutBlocks,
  coreStructureBlocks,
  imageBlocks,
  listBlocks,
  tableBlocks,
} from './block-catalog';
import { ADDRESSABLE_BLOCK_TYPES, BlockId } from './block-id';
import {
  Breadcrumb,
  breadcrumbBlocks,
  breadcrumbMarkdownAdapter,
  breadcrumbPlainTextAdapter,
} from './breadcrumb';
import { Callout, calloutMarkdownAdapter } from './callout';
import { ExocortexCodeBlock } from './code-block';
import { CollapsibleHeading } from './collapsible-heading';
import {
  COLUMN_EXTENSIONS,
  columnBlocks,
  columnsMarkdownAdapter,
  columnsPlainTextAdapter,
} from './columns';
import {
  type DocumentMigration,
  EXOCORTEX_SCHEMA_VERSION,
  type ExocortexEditorExtension,
  type MarkdownBlockSerializer,
  type MarkdownContainerOpener,
  type MarkdownExtensionAdapter,
  type MarkdownMarkSerializer,
  type MarkdownToken,
  type MarkdownTokenHandlerContext,
  type PlainTextAdapter,
} from './contract';
import {
  DatabaseEmbed,
  databaseEmbedBlocks,
  databaseEmbedMarkdownAdapter,
  databaseEmbedPlainTextAdapter,
} from './database-embed';
import {
  EMBED_EXTENSIONS,
  embedBlocks,
  embedMarkdownAdapter,
  embedPlainTextAdapter,
} from './embed';
import { INLINE_STYLING_EXTENSIONS, inlineStylingMarkdownAdapter } from './inline-styling';
import {
  WIKI_LINK_IDENTITY_ATTRIBUTE,
  WIKI_LINK_IDENTITY_HTML_ATTRIBUTE,
  wikiLinkDocumentId,
} from './link-target';
import { coreMarkdownAdapter } from './markdown/core-adapter';
import { WIKI_LINK_SCHEME } from './markdown/serialize';
import {
  MATHEMATICS_EXTENSIONS,
  mathematicsBlocks,
  mathematicsMarkdownAdapter,
  mathematicsPlainTextAdapter,
} from './mathematics';
import {
  MEDIA_EXTENSIONS,
  mediaBlocks,
  type MediaInfoResolver,
  mediaMarkdownAdapter,
  mediaPlainTextAdapter,
} from './media';
import { Mention, mentionMarkdownAdapter, mentionPlainTextAdapter } from './mention';
import {
  PageLink,
  pageLinkBlocks,
  pageLinkMarkdownAdapter,
  pageLinkPlainTextAdapter,
} from './page-link';
import { corePlainTextAdapter } from './plain-text-adapter';
import { SCHEMA_V2_MIGRATION } from './schema-v2';
import { SCHEMA_V3_MIGRATION } from './schema-v3';
import { SCHEMA_V4_MIGRATION } from './schema-v4';
import { SCHEMA_V5_MIGRATION } from './schema-v5';
import {
  TableOfContents,
  tableOfContentsBlocks,
  tableOfContentsMarkdownAdapter,
  tableOfContentsPlainTextAdapter,
} from './table-of-contents';
import {
  TOGGLE_EXTENSIONS,
  toggleBlocks,
  toggleMarkdownAdapter,
  togglePlainTextAdapter,
} from './toggle';

/**
 * The canonical extension registry.
 *
 * Everything schema-relevant lives here. React components consume
 * `buildEditorExtensions()`; they must never add nodes or marks of their own
 * (see docs/editor-extensions.md).
 */
export const EXOCORTEX_EDITOR_EXTENSIONS: readonly ExocortexEditorExtension[] = [
  {
    name: 'core-structure',
    schemaVersion: 1,
    extensions: [
      Document,
      Paragraph,
      Text,
      Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      HardBreak,
      HorizontalRule,
      Blockquote,
      ExocortexCodeBlock,
    ],
    markdown: coreMarkdownAdapter,
    plainText: corePlainTextAdapter,
    migrations: [SCHEMA_V2_MIGRATION, SCHEMA_V3_MIGRATION],
    blocks: coreStructureBlocks,
  },
  {
    name: 'core-marks',
    schemaVersion: 5,
    extensions: [
      Bold,
      Italic,
      Strike,
      Code,
      Link.extend({
        /**
         * The identity next to the address (issue #24).
         *
         * `[[Titel]]` in running text used to carry nothing but the title, so
         * renaming a page silently broke every mention of it in prose — the
         * exact problem `pageLink` was fixed for in issue #14, left standing
         * for the notation people actually use. The attribute is optional and
         * empty for every other kind of link; the address stays a title, so
         * an exported file still contains no internal identifiers.
         */
        addAttributes() {
          return {
            ...this.parent?.(),
            [WIKI_LINK_IDENTITY_ATTRIBUTE]: {
              default: null,
              parseHTML: (element: HTMLElement) =>
                element.getAttribute(WIKI_LINK_IDENTITY_HTML_ATTRIBUTE),
              renderHTML: (attributes: Record<string, unknown>) => {
                const documentId = wikiLinkDocumentId(attributes);
                return documentId === null
                  ? {}
                  : { [WIKI_LINK_IDENTITY_HTML_ATTRIBUTE]: documentId };
              },
            },
          };
        },

        renderHTML({ HTMLAttributes }) {
          const href = typeof HTMLAttributes.href === 'string' ? HTMLAttributes.href : '';
          const internal =
            href.toLowerCase().startsWith(WIKI_LINK_SCHEME) ||
            href.startsWith('/') ||
            href.startsWith('#');
          return [
            'a',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
              'data-link-kind': internal ? 'internal' : 'external',
              // An internal link stays inside the application; a new tab would be wrong.
              ...(internal ? { target: null, rel: null } : {}),
            }),
            0,
          ];
        },
      }).configure({
        openOnClick: false,
        autolink: true,
        // Wiki links use the internal `wiki:` scheme, so it must be allowed.
        protocols: ['http', 'https', 'mailto', { scheme: 'wiki', optionalSlashes: true }],
        // Stays correct for exported HTML and the non-editable state; the
        // click handler in apps/web opens with `noopener` on its own anyway.
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
    ],
    migrations: [SCHEMA_V5_MIGRATION],
  },
  {
    name: 'inline-styling',
    schemaVersion: 2,
    extensions: INLINE_STYLING_EXTENSIONS,
    markdown: inlineStylingMarkdownAdapter,
  },
  {
    name: 'mention',
    schemaVersion: 2,
    extensions: [Mention],
    markdown: mentionMarkdownAdapter,
    plainText: mentionPlainTextAdapter,
  },
  {
    name: 'lists',
    schemaVersion: 1,
    extensions: [BulletList, OrderedList, ListItem, TaskList, TaskItem.configure({ nested: true })],
    blocks: listBlocks,
  },
  {
    name: 'toggle',
    schemaVersion: 2,
    extensions: TOGGLE_EXTENSIONS,
    markdown: toggleMarkdownAdapter,
    plainText: togglePlainTextAdapter,
    blocks: toggleBlocks,
  },
  {
    name: 'collapsible-heading',
    schemaVersion: 2,
    extensions: [CollapsibleHeading],
  },
  {
    name: 'columns',
    schemaVersion: 2,
    extensions: COLUMN_EXTENSIONS,
    markdown: columnsMarkdownAdapter,
    plainText: columnsPlainTextAdapter,
    blocks: columnBlocks,
  },
  {
    name: 'mathematics',
    schemaVersion: 2,
    extensions: MATHEMATICS_EXTENSIONS,
    markdown: mathematicsMarkdownAdapter,
    plainText: mathematicsPlainTextAdapter,
    blocks: mathematicsBlocks,
  },
  {
    name: 'table-of-contents',
    schemaVersion: 2,
    extensions: [TableOfContents],
    markdown: tableOfContentsMarkdownAdapter,
    plainText: tableOfContentsPlainTextAdapter,
    blocks: tableOfContentsBlocks,
  },
  {
    name: 'page-link',
    // Introduced in 2, changed in 4 (the target's identity, issue #14).
    schemaVersion: 4,
    extensions: [PageLink],
    markdown: pageLinkMarkdownAdapter,
    plainText: pageLinkPlainTextAdapter,
    migrations: [SCHEMA_V4_MIGRATION],
    blocks: pageLinkBlocks,
  },
  {
    name: 'breadcrumb',
    schemaVersion: 2,
    extensions: [Breadcrumb],
    markdown: breadcrumbMarkdownAdapter,
    plainText: breadcrumbPlainTextAdapter,
    blocks: breadcrumbBlocks,
  },
  {
    name: 'database-embed',
    schemaVersion: 3,
    extensions: [DatabaseEmbed],
    markdown: databaseEmbedMarkdownAdapter,
    plainText: databaseEmbedPlainTextAdapter,
    blocks: databaseEmbedBlocks,
  },
  {
    name: 'tables',
    schemaVersion: 1,
    extensions: [Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    blocks: tableBlocks,
  },
  {
    name: 'media',
    schemaVersion: 1,
    extensions: [Image.configure({ inline: false, allowBase64: false })],
    blocks: imageBlocks,
  },
  {
    name: 'media-blocks',
    schemaVersion: 2,
    extensions: MEDIA_EXTENSIONS,
    markdown: mediaMarkdownAdapter,
    plainText: mediaPlainTextAdapter,
    blocks: mediaBlocks,
  },
  {
    name: 'embed',
    schemaVersion: 2,
    extensions: EMBED_EXTENSIONS,
    markdown: embedMarkdownAdapter,
    plainText: embedPlainTextAdapter,
    blocks: embedBlocks,
  },
  {
    name: 'callout',
    schemaVersion: 1,
    extensions: [Callout],
    markdown: calloutMarkdownAdapter,
    blocks: calloutBlocks,
  },
  {
    name: 'block-id',
    schemaVersion: 1,
    extensions: [BlockId.configure({ types: [...ADDRESSABLE_BLOCK_TYPES] })],
  },
];

export interface BuildEditorExtensionsOptions {
  /**
   * Collaboration extensions (Yjs) are injected by the client because they need
   * a live provider. They are never part of the canonical schema registry.
   */
  additionalExtensions?: Extensions;
  /**
   * Lets the media blocks describe what is inside a file (page count, title,
   * whether OCR ran). Injected for the same reason as the collaboration
   * provider: it needs the API, and this package must not know the API.
   *
   * An option, not a requirement. Without it the blocks render as they always
   * have, which is what keeps the canonical schema in `schema.ts` and the
   * extension tests free of a network seam.
   */
  mediaInfo?: MediaInfoResolver;
}

/** Names of the nodes built from `MEDIA_KINDS`; see `media.ts`. */
const MEDIA_NODE_NAMES = new Set(['fileAttachment', 'video', 'audio', 'pdf']);

/** Flattens the registry into the array Tiptap expects. */
export function buildEditorExtensions(options: BuildEditorExtensionsOptions = {}): Extensions {
  const mediaInfo = options.mediaInfo;
  return [
    ...EXOCORTEX_EDITOR_EXTENSIONS.flatMap((entry) => entry.extensions).map((extension) =>
      // `configure` changes options only, never the schema, so the document
      // model stays identical whether or not a resolver was supplied.
      mediaInfo !== undefined && MEDIA_NODE_NAMES.has(extension.name)
        ? extension.configure({ mediaInfo })
        : extension,
    ),
    ...(options.additionalExtensions ?? []),
  ];
}

export interface MarkdownRegistry {
  blocks: Record<string, MarkdownBlockSerializer>;
  marks: Record<string, MarkdownMarkSerializer>;
  tokens: Record<
    string,
    (token: MarkdownToken, context: MarkdownTokenHandlerContext) => boolean | void
  >;
  containers: Record<string, MarkdownContainerOpener>;
}

/** Merges the Markdown adapters of every registered extension. */
export function buildMarkdownRegistry(
  extensions: readonly ExocortexEditorExtension[] = EXOCORTEX_EDITOR_EXTENSIONS,
): MarkdownRegistry {
  const registry: MarkdownRegistry = { blocks: {}, marks: {}, tokens: {}, containers: {} };
  for (const entry of extensions) {
    const adapter: MarkdownExtensionAdapter | undefined = entry.markdown;
    if (adapter === undefined) continue;
    Object.assign(registry.blocks, adapter.blocks ?? {});
    Object.assign(registry.marks, adapter.marks ?? {});
    Object.assign(registry.tokens, adapter.tokens ?? {});
    Object.assign(registry.containers, adapter.containers ?? {});
  }
  return registry;
}

/** Merges the plain-text adapters of every registered extension. */
export function buildPlainTextRegistry(
  extensions: readonly ExocortexEditorExtension[] = EXOCORTEX_EDITOR_EXTENSIONS,
): NonNullable<PlainTextAdapter['blocks']> {
  const blocks: NonNullable<PlainTextAdapter['blocks']> = {};
  for (const entry of extensions) {
    Object.assign(blocks, entry.plainText?.blocks ?? {});
  }
  return blocks;
}

/** All migrations contributed by extensions, ordered by target version. */
export function collectMigrations(
  extensions: readonly ExocortexEditorExtension[] = EXOCORTEX_EDITOR_EXTENSIONS,
): DocumentMigration[] {
  return extensions
    .flatMap((entry) => entry.migrations ?? [])
    .sort((a, b) => a.toVersion - b.toVersion);
}

/**
 * The block catalog of every registered extension, in registry order.
 *
 * One list, three consumers: the slash menu, the "turn into" menu and the block
 * action menu. A new block appears in all of them by adding a catalog entry.
 */
export function buildBlockCatalog(
  extensions: readonly ExocortexEditorExtension[] = EXOCORTEX_EDITOR_EXTENSIONS,
): BlockCatalogEntry[] {
  return extensions.flatMap((entry) => entry.blocks ?? []);
}

/** Highest schema version any registered extension declares. */
export function registrySchemaVersion(): number {
  return Math.max(
    EXOCORTEX_SCHEMA_VERSION,
    ...EXOCORTEX_EDITOR_EXTENSIONS.map((entry) => entry.schemaVersion),
  );
}
