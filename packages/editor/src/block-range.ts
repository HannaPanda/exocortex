import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument } from './contract';
import { serializePlainText } from './plain-text';
import { getExocortexSchema, validateProseMirrorDocument } from './schema';
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
  | 'block_range_inverted';

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

/**
 * Applies a ranged edit to a live `Y.Doc`.
 *
 * One transaction, so a connected editor sees one change rather than a delete
 * followed by an insert, and the document is never briefly missing the
 * paragraph somebody is reading.
 */
export function applyBlockRangeEditToYDoc(
  target: Y.Doc,
  document: ProseMirrorDocument,
  edit: BlockRangeEdit,
): void {
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
    target.transact(() => {
      range.parent.delete(range.index, range.count);
    });
    return;
  }

  const source = prosemirrorJSONToYDoc(getExocortexSchema(), document, YJS_DOCUMENT_FIELD);
  try {
    const nodes = source
      .getXmlFragment(YJS_DOCUMENT_FIELD)
      .toArray()
      .filter(
        (node): node is Y.XmlElement | Y.XmlText =>
          node instanceof Y.XmlElement || node instanceof Y.XmlText,
      )
      .map((node) => node.clone());

    target.transact(() => {
      if (edit.placement === 'replace') {
        range.parent.delete(range.index, range.count);
        range.parent.insert(range.index, nodes);
        return;
      }
      const at = edit.placement === 'before' ? range.index : range.index + range.count;
      range.parent.insert(at, nodes);
    });
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
    applyBlockRangeEditToYDoc(doc, document, edit);
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
      blockIds: (document.content ?? [])
        .map((node) => node.attrs?.[BLOCK_ID_ATTRIBUTE])
        .filter((id): id is string => typeof id === 'string'),
    };
  } finally {
    doc.destroy();
  }
}
