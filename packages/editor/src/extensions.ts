import { type Extensions } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Bold } from '@tiptap/extension-bold';
import { Code } from '@tiptap/extension-code';
import { CodeBlock } from '@tiptap/extension-code-block';
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

import { ADDRESSABLE_BLOCK_TYPES, BlockId } from './block-id';
import { Callout, calloutMarkdownAdapter } from './callout';
import {
  type DocumentMigration,
  EXOCORTEX_SCHEMA_VERSION,
  type ExocortexEditorExtension,
  type MarkdownBlockSerializer,
  type MarkdownExtensionAdapter,
  type MarkdownMarkSerializer,
  type MarkdownToken,
  type MarkdownTokenHandlerContext,
  type PlainTextAdapter,
} from './contract';
import { coreMarkdownAdapter } from './markdown/core-adapter';
import { corePlainTextAdapter } from './plain-text-adapter';

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
      CodeBlock.configure({ languageClassPrefix: 'language-' }),
    ],
    markdown: coreMarkdownAdapter,
    plainText: corePlainTextAdapter,
  },
  {
    name: 'core-marks',
    schemaVersion: 1,
    extensions: [
      Bold,
      Italic,
      Strike,
      Code,
      Link.configure({
        openOnClick: false,
        autolink: true,
        // Wiki links use the internal `wiki:` scheme, so it must be allowed.
        protocols: ['http', 'https', 'mailto', { scheme: 'wiki', optionalSlashes: true }],
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
    ],
  },
  {
    name: 'lists',
    schemaVersion: 1,
    extensions: [BulletList, OrderedList, ListItem, TaskList, TaskItem.configure({ nested: true })],
  },
  {
    name: 'tables',
    schemaVersion: 1,
    extensions: [Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
  },
  {
    name: 'media',
    schemaVersion: 1,
    extensions: [Image.configure({ inline: false, allowBase64: false })],
  },
  {
    name: 'callout',
    schemaVersion: 1,
    extensions: [Callout],
    markdown: calloutMarkdownAdapter,
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
}

/** Flattens the registry into the array Tiptap expects. */
export function buildEditorExtensions(options: BuildEditorExtensionsOptions = {}): Extensions {
  return [
    ...EXOCORTEX_EDITOR_EXTENSIONS.flatMap((entry) => entry.extensions),
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
}

/** Merges the Markdown adapters of every registered extension. */
export function buildMarkdownRegistry(
  extensions: readonly ExocortexEditorExtension[] = EXOCORTEX_EDITOR_EXTENSIONS,
): MarkdownRegistry {
  const registry: MarkdownRegistry = { blocks: {}, marks: {}, tokens: {} };
  for (const entry of extensions) {
    const adapter: MarkdownExtensionAdapter | undefined = entry.markdown;
    if (adapter === undefined) continue;
    Object.assign(registry.blocks, adapter.blocks ?? {});
    Object.assign(registry.marks, adapter.marks ?? {});
    Object.assign(registry.tokens, adapter.tokens ?? {});
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

/** Highest schema version any registered extension declares. */
export function registrySchemaVersion(): number {
  return Math.max(
    EXOCORTEX_SCHEMA_VERSION,
    ...EXOCORTEX_EDITOR_EXTENSIONS.map((entry) => entry.schemaVersion),
  );
}
