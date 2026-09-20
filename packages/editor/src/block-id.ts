import { Extension } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** HTML attribute the block identifier is rendered to. */
export const BLOCK_ID_HTML_ATTRIBUTE = 'data-block-id';
export const BLOCK_ID_ATTRIBUTE = 'blockId';

/**
 * Block node types that are addressable and therefore carry a stable
 * identifier. Inline nodes (text, hard breaks, images) are intentionally not
 * addressable: they are always addressed through their containing block.
 *
 * Identity must never be derived from document offsets, Markdown line numbers or
 * array indexes (see ADR-003).
 */
export const ADDRESSABLE_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'horizontalRule',
  'table',
  'tableRow',
  'callout',
  'details',
  'columnList',
  'column',
  'blockMath',
  'tableOfContents',
  'pageLink',
  'breadcrumb',
  'databaseEmbed',
  'transclusion',
  'fileAttachment',
  'video',
  'audio',
  'pdf',
  'embed',
  'bookmark',
] as const;

const BLOCK_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BLOCK_ID_LENGTH = 12;

/**
 * Creates a new block identifier. Uses the Web Crypto API, which is available in
 * browsers and in Node 24 without an import.
 */
export function createBlockId(): string {
  const bytes = new Uint8Array(BLOCK_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) {
    id += BLOCK_ID_ALPHABET[byte % BLOCK_ID_ALPHABET.length];
  }
  return id;
}

export function isValidBlockId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{8,32}$/.test(value);
}

/**
 * Collects the identifiers of the addressable blocks a range touches, in
 * document order and without duplicates.
 *
 * Used when a selection is handed to the AI: the text alone says what was
 * picked, the identifiers say where it lives, so the assistant can address the
 * same blocks later (`exo_page_read` returns these identifiers too) instead of
 * matching on prose.
 *
 * A block that has not been assigned an identifier yet -- the plugin above runs
 * on the next transaction, so a freshly created block can briefly have none --
 * is skipped rather than guessed at.
 */
export function collectBlockIdsInRange(doc: PmNode, from: number, to: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  doc.nodesBetween(from, to, (node) => {
    const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
    if (isValidBlockId(id) && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
    return true;
  });
  return ids;
}

export interface BlockIdOptions {
  /** Node type names that receive a stable identifier. */
  types: string[];
}

export const blockIdPluginKey = new PluginKey('exocortexBlockId');

interface PendingAssignment {
  position: number;
  node: PmNode;
  id: string;
}

/**
 * Assigns and preserves stable block identifiers.
 *
 * Behaviour:
 *  * newly created blocks receive an identifier
 *  * existing identifiers are preserved while editing, during collaboration and
 *    during Markdown import
 *  * duplicated identifiers (copy/paste, concurrent edits, malformed import) are
 *    detected and the later occurrence is re-assigned
 */
export const BlockId = Extension.create<BlockIdOptions>({
  name: 'exocortexBlockId',

  addOptions() {
    return { types: [...ADDRESSABLE_BLOCK_TYPES] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          [BLOCK_ID_ATTRIBUTE]: {
            default: null,
            // A split must not duplicate the identifier; the plugin assigns a
            // fresh one to the new node.
            keepOnSplit: false,
            parseHTML: (element) => element.getAttribute(BLOCK_ID_HTML_ATTRIBUTE),
            renderHTML: (attributes) => {
              const value = attributes[BLOCK_ID_ATTRIBUTE];
              if (typeof value !== 'string' || value.length === 0) return {};
              return { [BLOCK_ID_HTML_ATTRIBUTE]: value };
            },
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    const managedTypes = new Set(this.options.types);

    return [
      new Plugin({
        key: blockIdPluginKey,
        appendTransaction: (transactions, _oldState, newState) => {
          const documentChanged = transactions.some((transaction) => transaction.docChanged);
          if (!documentChanged) return null;

          const seen = new Set<string>();
          const pending: PendingAssignment[] = [];

          newState.doc.descendants((node, position) => {
            if (!managedTypes.has(node.type.name)) return true;
            const current = node.attrs[BLOCK_ID_ATTRIBUTE];
            if (isValidBlockId(current) && !seen.has(current)) {
              seen.add(current);
              return true;
            }
            let id = createBlockId();
            while (seen.has(id)) id = createBlockId();
            seen.add(id);
            pending.push({ position, node, id });
            return true;
          });

          if (pending.length === 0) return null;

          const transaction = newState.tr;
          for (const assignment of pending) {
            transaction.setNodeMarkup(assignment.position, undefined, {
              ...assignment.node.attrs,
              [BLOCK_ID_ATTRIBUTE]: assignment.id,
            });
          }
          /*
           * Deliberately *without* `addToHistory: false` (issue #91).
           *
           * Under Yjs that flag does not mark this transaction: `ySyncPlugin`
           * reads it from the last transaction of the dispatch and then writes
           * the whole document diff into one Yjs transaction carrying that
           * value, which the undo manager skips. Since this plugin appends
           * exactly when a block was created, setting it here erased the user's
           * own change from the undo stack: inserting a table, and deleting one,
           * could not be undone at all, while typing -- which creates no block
           * -- could. The assignment belongs to the change that created the
           * block, so travelling with it is also the right grouping.
           *
           * `preventUpdate` stays: identifier bookkeeping is not an edit the
           * application needs to hear about.
           */
          transaction.setMeta('preventUpdate', true);
          return transaction;
        },
      }),
    ];
  },
});
