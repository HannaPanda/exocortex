import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument } from './contract';
import { serializePlainText } from './plain-text';
import { getExocortexSchema, validateProseMirrorDocument } from './schema';
import {
  findBlocksInTableCells,
  TABLE_CELL_TYPES,
  tableCellViolationMessage,
} from './table-cell-blocks';
import { YJS_DOCUMENT_FIELD, yjsStateToDocument, yjsStateToProseMirrorJson } from './yjs';

/**
 * Editing part of a page without rewriting the page (issue #111).
 *
 * Until now the only writes that did not come from the editor were whole-page
 * ones: `replace`, `append`, `prepend`. Changing one line of a long page
 * therefore meant sending the whole page back, which costs an agent its context
 * window, regenerates every block identifier on the way through, and overwrites
 * whatever somebody else wrote while it was thinking.
 *
 * A range here is named by block identifiers, which is the addressing the page
 * already has: `exo_page_read` hands them out, comments anchor on them, and a
 * transclusion points at one. Everything outside the range is not rewritten,
 * not re-serialized and not re-identified -- it is not touched at all, so it
 * keeps its identifiers, its Yjs history and any edit that landed on it a
 * moment ago.
 *
 * The same description travels to the collaboration server, which applies it to
 * the living document (ADR-016). Both sides call the function below, so "which
 * blocks does this address" has exactly one answer.
 */

/**
 * Which blocks an edit addresses, and where the new content goes.
 *
 * Mirrored as a zod schema in `@exocortex/contracts`
 * (`blockRangeEditSchema`), because that package and this one are both leaves
 * and neither may import the other. The two definitions are three fields long
 * and the schema names this type in a comment; a field added to one without the
 * other fails the API's typecheck at the call site.
 */
export interface BlockRangeEdit {
  /** Block identifier of the first block in the range. */
  fromBlockId: string;
  /** The last block, when the range spans several. `null` means `fromBlockId` alone. */
  toBlockId: string | null;
  /**
   * `replace` swaps the range out for the new content. `before` and `after`
   * keep it and insert beside it, which is how a section is appended to without
   * rewriting what is already under the heading.
   */
  placement: 'replace' | 'before' | 'after';
}

export type BlockRangeRefusal =
  /** No block on the page carries this identifier. */
  | 'block_not_found'
  /** Both blocks exist, but not as siblings, so they do not describe a range. */
  | 'block_range_not_siblings'
  /** The end of the range sits before its start. */
  | 'block_range_inverted'
  /**
   * Items for a list of the other kind: task items for a bullet or numbered
   * list, or the reverse (issue #247). Converting one into the other would
   * guess at a checkbox nobody asked for.
   */
  | 'list_kind_mismatch'
  /**
   * Something other than list items, aimed at a list item, or list items mixed
   * with other blocks, aimed at a list (issue #247). Where the items end and
   * the rest begins would be a guess.
   */
  | 'list_expects_items'
  /**
   * The paragraph is the text of a list item that has more under it. Deleting
   * it would leave an item without its text, and deleting the item instead
   * would take the sub-items with it, which nobody named (issue #247).
   */
  | 'list_item_text'
  /**
   * The content holds a database, and the place it is aimed at lies inside a
   * table cell, where no database stands (issue #312).
   */
  | 'database_in_table_cell';

export class BlockRangeError extends Error {
  public readonly reason: BlockRangeRefusal;
  public readonly blockId: string;

  constructor(reason: BlockRangeRefusal, blockId: string, message: string) {
    super(message);
    this.name = 'BlockRangeError';
    this.reason = reason;
    this.blockId = blockId;
  }
}

type YNode = Y.XmlElement | Y.XmlText | Y.XmlHook;
type YParent = Y.XmlFragment | Y.XmlElement;

/** The parent holding a block, and the block's index among its siblings. */
interface LocatedBlock {
  parent: YParent;
  index: number;
}

function blockIdOf(node: YNode): string | null {
  if (!(node instanceof Y.XmlElement)) return null;
  const value: unknown = node.getAttribute(BLOCK_ID_ATTRIBUTE);
  return typeof value === 'string' ? value : null;
}

/**
 * Depth-first search for a block identifier in a live Yjs fragment.
 *
 * Deliberately on the Yjs side rather than on ProseMirror JSON with the indexes
 * carried over: the JSON is derived, and an index that is correct in the
 * derivation but wrong in the fragment would delete the wrong block. Here the
 * thing that is searched is the thing that is edited.
 */
function locate(parent: YParent, blockId: string): LocatedBlock | null {
  const children = parent.toArray();
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as YNode;
    if (blockIdOf(child) === blockId) return { parent, index };
    if (child instanceof Y.XmlElement) {
      const inside = locate(child, blockId);
      if (inside !== null) return inside;
    }
  }
  return null;
}

/** The siblings an edit addresses: where they start and how many there are. */
export interface ResolvedBlockRange {
  parent: YParent;
  index: number;
  count: number;
}

export function resolveBlockRange(doc: Y.Doc, edit: BlockRangeEdit): ResolvedBlockRange {
  const fragment = doc.getXmlFragment(YJS_DOCUMENT_FIELD);
  const start = locate(fragment, edit.fromBlockId);
  if (start === null) {
    throw new BlockRangeError(
      'block_not_found',
      edit.fromBlockId,
      `No block on this page carries the identifier ${edit.fromBlockId}`,
    );
  }
  if (edit.toBlockId === null) return { ...start, count: 1 };

  const end = locate(fragment, edit.toBlockId);
  if (end === null) {
    throw new BlockRangeError(
      'block_not_found',
      edit.toBlockId,
      `No block on this page carries the identifier ${edit.toBlockId}`,
    );
  }
  if (end.parent !== start.parent) {
    throw new BlockRangeError(
      'block_range_not_siblings',
      edit.toBlockId,
      'The two blocks are not siblings, so they do not describe a range',
    );
  }
  if (end.index < start.index) {
    throw new BlockRangeError(
      'block_range_inverted',
      edit.toBlockId,
      'The end of the range sits before its start',
    );
  }
  return { ...start, count: end.index - start.index + 1 };
}

// --- Lists (issue #247) ---------------------------------------------------

/** Each list container, and the one kind of item it holds. */
const LIST_ITEM_OF: Readonly<Record<string, string>> = {
  bulletList: 'listItem',
  orderedList: 'listItem',
  taskList: 'taskItem',
};
const LIST_ITEMS = new Set(['listItem', 'taskItem']);

function isListContainer(node: YNode | null): node is Y.XmlElement {
  return node instanceof Y.XmlElement && LIST_ITEM_OF[node.nodeName] !== undefined;
}

function isListItem(node: unknown): node is Y.XmlElement {
  return node instanceof Y.XmlElement && LIST_ITEMS.has(node.nodeName);
}

/** Where new nodes go, and how many existing ones they take the place of. */
interface Insertion {
  parent: YParent;
  index: number;
  deleteCount: number;
  /** The incoming list's items rather than the incoming blocks themselves. */
  itemsOnly: boolean;
}

function idOrEmpty(node: Y.XmlElement): string {
  return blockIdOf(node) ?? '';
}

/** The list type an incoming document consists of, when it is exactly one list. */
function incomingList(document: ProseMirrorDocument): string | null {
  const content = document.content ?? [];
  if (content.length !== 1) return null;
  const only = content[0]?.type ?? '';
  return LIST_ITEM_OF[only] === undefined ? null : only;
}

function containsList(document: ProseMirrorDocument): boolean {
  return (document.content ?? []).some((node) => LIST_ITEM_OF[node.type] !== undefined);
}

function refuseKindMismatch(itemKind: string, list: string, anchor: Y.XmlElement): never {
  const wanted = itemKind === 'taskItem' ? 'task items ("- [ ] …")' : 'list items ("- …")';
  throw new BlockRangeError(
    'list_kind_mismatch',
    idOrEmpty(anchor),
    `This list holds ${itemKind === 'taskItem' ? 'task items' : 'list items'}, ` +
      `and a ${list} cannot become one of them; send ${wanted}`,
  );
}

/**
 * How a block edit lands when it is aimed at a list (issue #247).
 *
 * Without this, list items appended to a list became a *second* list beside it
 * -- the incoming Markdown is a document, its top level is a list, and that
 * list was inserted as a sibling -- and list items appended to an item were
 * refused outright, because a list cannot stand directly inside a list.
 *
 * The rule: whoever addresses a list, or one of its items, and sends nothing
 * but list items gets new entries *in that list*, at that position, with any
 * nesting the items carry. Neighbouring lists are never merged, because only
 * the addressed list is ever written to. Anything that does not fit that rule
 * unambiguously is refused rather than placed by guesswork (ADR-055).
 *
 * `null` means the edit is not about a list and goes through unchanged.
 */
function listInsertion(
  range: ResolvedBlockRange,
  document: ProseMirrorDocument,
  placement: BlockRangeEdit['placement'],
): Insertion | null {
  if (range.count !== 1) return null;
  const target = range.parent.get(range.index) as YNode;
  const list = incomingList(document);

  if (isListContainer(target)) {
    if (placement === 'replace') return null;
    if (list === null) {
      if (!containsList(document)) return null;
      throw new BlockRangeError(
        'list_expects_items',
        idOrEmpty(target),
        'List items and other blocks in one write aimed at a list: send the items alone, ' +
          'which join the list, and the rest in a second write',
      );
    }
    const itemKind = LIST_ITEM_OF[target.nodeName] as string;
    if (LIST_ITEM_OF[list] !== itemKind) refuseKindMismatch(itemKind, list, target);
    const index = placement === 'before' ? 0 : target.length;
    return { parent: target, index, deleteCount: 0, itemsOnly: true };
  }

  // A list item, or the paragraph that is its text: `exo_page_read` writes
  // both identifiers behind the line, and either means "this entry".
  const itemText =
    range.index === 0 && isListItem(range.parent) && placement !== 'replace' && list !== null;
  const item = isListItem(target) ? target : itemText ? (range.parent as Y.XmlElement) : null;
  if (item === null) return null;

  if (list === null) {
    throw new BlockRangeError(
      'list_expects_items',
      idOrEmpty(item),
      'Only list items can stand beside a list item; send them as "- …"',
    );
  }
  if (LIST_ITEM_OF[list] !== item.nodeName) refuseKindMismatch(item.nodeName, list, item);

  const container = item.parent as Y.XmlElement;
  const at = container.toArray().indexOf(item);
  return {
    parent: container,
    index: placement === 'after' ? at + 1 : at,
    deleteCount: placement === 'replace' ? 1 : 0,
    itemsOnly: true,
  };
}

/**
 * Deletes a range, and every list the deletion leaves without items.
 *
 * "Delete" has to mean gone (issue #247): an item without its text is not an
 * item, and a list without items is an empty shell nobody can address any more
 * once its last entry is gone. Only list containers go along; a quote or a
 * table cell that would end up empty is left for the validation to refuse,
 * because removing those would take something with it that was not named.
 */
function deleteRange(range: ResolvedBlockRange): void {
  const { parent } = range;
  if (isListItem(parent) && range.index === 0 && range.count < parent.length) {
    const itemId = idOrEmpty(parent);
    throw new BlockRangeError(
      'list_item_text',
      itemId,
      `This block is the text of a list item with more under it; delete the item itself ` +
        `(${itemId}) to remove it with its sub-items, or replace the text instead`,
    );
  }
  parent.delete(range.index, range.count);

  let current: YParent = parent;
  while (
    current instanceof Y.XmlElement &&
    current.length === 0 &&
    (isListItem(current) || isListContainer(current))
  ) {
    const above: unknown = current.parent;
    if (!(above instanceof Y.XmlElement || above instanceof Y.XmlFragment)) break;
    above.delete(above.toArray().indexOf(current), 1);
    current = above;
  }
}

/** Whether a Yjs parent is a table cell or stands inside one. */
function insideTableCell(parent: YParent): boolean {
  let current: unknown = parent;
  while (current instanceof Y.XmlElement) {
    if (TABLE_CELL_TYPES.has(current.nodeName)) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Refuses a database aimed into a table cell (issue #312), by name and before
 * anything is written, rather than as the finished page failing validation:
 * the agent learns what to send instead.
 */
function refuseDatabaseInTableCell(
  insertion: Insertion,
  document: ProseMirrorDocument,
  edit: BlockRangeEdit,
): void {
  if (!insideTableCell(insertion.parent)) return;
  // The incoming blocks as if they stood in a cell, which is where they go.
  const [violation] = findBlocksInTableCells({
    type: 'tableCell',
    content: document.content ?? [],
  });
  if (violation === undefined) return;
  throw new BlockRangeError(
    'database_in_table_cell',
    edit.fromBlockId,
    tableCellViolationMessage(violation),
  );
}

/** The ids of the nodes an edit put on the page, for the response. */
function idsOf(nodes: readonly (Y.XmlElement | Y.XmlText)[]): string[] {
  return nodes
    .map((node) => (node instanceof Y.XmlElement ? blockIdOf(node) : null))
    .filter((id): id is string => id !== null);
}

/**
 * Applies a ranged edit to a live `Y.Doc`, and answers with the identifiers of
 * the blocks it put on the page.
 *
 * One transaction, so a connected editor sees one change rather than a delete
 * followed by an insert, and the document is never briefly missing the
 * paragraph somebody is reading.
 */
export function applyBlockRangeEditToYDoc(
  target: Y.Doc,
  document: ProseMirrorDocument,
  edit: BlockRangeEdit,
): string[] {
  /*
   * A document with no blocks is a deletion (issue #118): the range goes and
   * nothing takes its place. It is spelled this way rather than with a fourth
   * placement because it is the same surgery on the same range, and because a
   * deletion has to travel to the collaboration server through the one field
   * that carries content. The schema refuses an empty document -- `block+` --
   * so it is not validated here; what matters is the page afterwards, and that
   * is checked below and in `applyBlockRangeEditToState`.
   */
  const deletion = (document.content ?? []).length === 0;
  if (deletion && edit.placement !== 'replace') {
    throw new Error('An empty document deletes a range; it cannot be inserted beside one');
  }
  if (!deletion) {
    const validation = validateProseMirrorDocument(document);
    if (!validation.valid) {
      throw new Error(`Refusing to apply an invalid document: ${validation.error ?? 'unknown'}`);
    }
  }

  const range = resolveBlockRange(target, edit);
  if (deletion) {
    target.transact(() => deleteRange(range));
    return [];
  }

  const insertion: Insertion = listInsertion(range, document, edit.placement) ?? {
    parent: range.parent,
    index: edit.placement === 'after' ? range.index + range.count : range.index,
    deleteCount: edit.placement === 'replace' ? range.count : 0,
    itemsOnly: false,
  };
  refuseDatabaseInTableCell(insertion, document, edit);

  const source = prosemirrorJSONToYDoc(getExocortexSchema(), document, YJS_DOCUMENT_FIELD);
  try {
    const top = source.getXmlFragment(YJS_DOCUMENT_FIELD).toArray();
    // The items of the incoming list rather than the list: they join the one
    // on the page, with whatever is nested inside them.
    const incoming = insertion.itemsOnly ? (top[0] as Y.XmlElement).toArray() : top;
    const nodes = incoming
      .filter(
        (node): node is Y.XmlElement | Y.XmlText =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText,
      )
      .map((node) => node.clone());

    target.transact(() => {
      if (insertion.deleteCount > 0)
        insertion.parent.delete(insertion.index, insertion.deleteCount);
      insertion.parent.insert(insertion.index, nodes);
    });
    return idsOf(nodes);
  } finally {
    source.destroy();
  }
}

/** What a ranged edit leaves behind, mirroring `AppliedDocumentState`. */
export interface AppliedBlockRange {
  yjsState: Uint8Array;
  proseMirrorJson: ProseMirrorDocument;
  plainText: string;
  /** Identifiers of the blocks that now stand where the edit landed. */
  blockIds: string[];
}

/**
 * The same edit against *stored* binary state.
 *
 * The result is validated before it is handed back, which the whole-document
 * path does not have to do: replacing a page cannot produce a shape the schema
 * refuses, because the incoming document was checked as a document. A range can
 * sit inside a list or a table, where a heading is not allowed to go, and a
 * fragment that is fine on its own is not necessarily fine there. Catching that
 * here is what keeps a refusal a refusal instead of a page the editor can no
 * longer open.
 */
export function applyBlockRangeEditToState(
  state: Uint8Array,
  document: ProseMirrorDocument,
  edit: BlockRangeEdit,
): AppliedBlockRange {
  const doc = yjsStateToDocument(state);
  try {
    const blockIds = applyBlockRangeEditToYDoc(doc, document, edit);
    const yjsState = Y.encodeStateAsUpdate(doc);
    const proseMirrorJson = yjsStateToProseMirrorJson(yjsState);
    const validation = validateProseMirrorDocument(proseMirrorJson);
    if (!validation.valid) {
      throw new Error(
        `This edit would make the page invalid at that position: ${validation.error ?? 'unknown'}`,
      );
    }
    return {
      yjsState,
      proseMirrorJson,
      plainText: serializePlainText(proseMirrorJson),
      blockIds,
    };
  } finally {
    doc.destroy();
  }
}
