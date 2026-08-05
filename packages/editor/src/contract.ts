import { type Extensions } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';

/**
 * Version of the canonical Exocortex document schema.
 *
 * Bump this whenever a node, mark or attribute changes in a way that stored
 * documents must be migrated for. Every `DocumentContent` and
 * `DocumentSnapshot` row stores the version it was written with.
 */
export const EXOCORTEX_SCHEMA_VERSION = 3;

/** Minimal structural view of a ProseMirror JSON node. */
export interface ProseMirrorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ProseMirrorNode[];
  marks?: ProseMirrorMark[];
  text?: string;
}

export interface ProseMirrorDocument extends ProseMirrorNode {
  type: 'doc';
  content?: ProseMirrorNode[];
}

// --------------------------------------------------------------------------
// Markdown adapters
// --------------------------------------------------------------------------

export interface MarkdownSerializerContext {
  /**
   * Serializes the children of `node` as block content, without indentation.
   * The caller applies indentation with `indentBlock`, which keeps nesting
   * rules in one place.
   */
  renderBlockChildren(node: ProseMirrorNode): string;
  /** Serializes a single block node. */
  renderBlock(node: ProseMirrorNode): string;
  /** Serializes inline content (text plus marks) of `node`. */
  renderInline(node: ProseMirrorNode): string;
  /**
   * Prefixes the first line with `firstPrefix` and all following lines with
   * `restPrefix`. Empty lines keep the trimmed prefix.
   */
  indentBlock(text: string, firstPrefix: string, restPrefix: string): string;
  /** Whether stable block identifiers should be embedded in the output. */
  includeBlockIds: boolean;
  /** Renders the `^blockId` suffix when enabled, otherwise an empty string. */
  blockIdSuffix(node: ProseMirrorNode): string;
}

/** Serializes one block-level node to Markdown, including its trailing newline. */
export type MarkdownBlockSerializer = (
  node: ProseMirrorNode,
  context: MarkdownSerializerContext,
) => string;

/** Wraps already rendered inline content in the Markdown syntax of a mark. */
export interface MarkdownMarkSerializer {
  open: string | ((mark: ProseMirrorMark) => string);
  close: string | ((mark: ProseMirrorMark) => string);
  /** Marks with a higher priority are applied further outside. */
  priority?: number;
  /** When true, nested marks inside are not escaped (used for inline code). */
  raw?: boolean;
}

/** Handles one markdown-it token stream entry during import. */
export interface MarkdownTokenHandlerContext {
  /** Pushes a node onto the current parent and descends into it. */
  openNode(type: string, attrs?: Record<string, unknown>): void;
  /** Closes the most recently opened node. */
  closeNode(): void;
  /** Adds a node with optional pre-built content to the current parent. */
  addNode(type: string, attrs?: Record<string, unknown>, content?: ProseMirrorNode[]): void;
  /** Adds a node whose only content is a single unformatted text run. */
  addTextNode(type: string, text: string, attrs?: Record<string, unknown>): void;
  /** Adds text with the currently active marks. */
  addText(text: string): void;
  openMark(type: string, attrs?: Record<string, unknown>): void;
  closeMark(type: string): void;
}

/**
 * Opens the nodes for one `:::name` container during Markdown import.
 *
 * Returns how many nodes were opened; the importer closes exactly that many when
 * it reaches the closing `:::`, so a handler never has to track nesting itself.
 * A leaf container (`:::toc`) adds its node and returns `0`.
 */
export type MarkdownContainerOpener = (
  params: string,
  context: MarkdownTokenHandlerContext,
) => number;

export interface MarkdownExtensionAdapter {
  /** Block serializers keyed by ProseMirror node type name. */
  blocks?: Record<string, MarkdownBlockSerializer>;
  /** Mark serializers keyed by ProseMirror mark type name. */
  marks?: Record<string, MarkdownMarkSerializer>;
  /**
   * markdown-it token handlers keyed by token type (`bullet_list_open`, …).
   * Returning `true` marks the token as handled.
   */
  tokens?: Record<
    string,
    (token: MarkdownToken, context: MarkdownTokenHandlerContext) => boolean | void
  >;
  /**
   * Handlers for the Exocortex container syntax, keyed by container name
   * (`toggle`, `columns`, `toc`, …). See `markdown/container-rule.ts`.
   */
  containers?: Record<string, MarkdownContainerOpener>;
}

/** Subset of the markdown-it token shape that adapters may rely on. */
export interface MarkdownToken {
  type: string;
  tag: string;
  info: string;
  content: string;
  markup: string;
  level: number;
  nesting: number;
  /** markdown-it allows numeric attribute values, so the union is not optional. */
  attrs: [string, string | number][] | null;
  children: MarkdownToken[] | null;
  attrGet(name: string): string | number | null;
}

// --------------------------------------------------------------------------
// Plain text adapters
// --------------------------------------------------------------------------

export interface PlainTextAdapter {
  /**
   * Renders a block node to plain text. Return `undefined` to fall back to the
   * default behaviour (concatenating child text).
   */
  blocks?: Record<
    string,
    (node: ProseMirrorNode, renderChildren: (node: ProseMirrorNode) => string) => string | undefined
  >;
}

// --------------------------------------------------------------------------
// Migrations
// --------------------------------------------------------------------------

export interface DocumentMigration {
  /** Document schema version this migration upgrades *from*. */
  fromVersion: number;
  /** Document schema version this migration upgrades *to*. */
  toVersion: number;
  description: string;
  migrate(document: ProseMirrorDocument): ProseMirrorDocument;
}

// --------------------------------------------------------------------------
// Extension contract
// --------------------------------------------------------------------------

/**
 * The contract every Exocortex editor extension implements.
 *
 * `packages/editor` owns all Tiptap extensions. React components must never
 * define schema-relevant extensions themselves (see docs/editor-extensions.md).
 */
export interface ExocortexEditorExtension {
  /** Stable identifier, used in logs and migration descriptions. */
  name: string;
  /** Schema version this extension was introduced or last changed in. */
  schemaVersion: number;
  /**
   * Tiptap extensions contributed by this unit. An array is allowed because a
   * single conceptual feature (lists, tables) maps to several Tiptap nodes.
   */
  extensions: Extensions;
  markdown?: MarkdownExtensionAdapter;
  plainText?: PlainTextAdapter;
  migrations?: DocumentMigration[];
  /**
   * Entries for the block catalog, which feeds the slash menu, the "turn into"
   * menu and the block action menu. See `block-catalog.ts`.
   */
  blocks?: readonly BlockCatalogEntry[];
}
