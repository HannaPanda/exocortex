import { Extension } from '@tiptap/core';
import {
  Fragment,
  type Node as PmNode,
  type ResolvedPos,
  type Schema,
  Slice,
} from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

import { type BlockCatalogEntry } from './block-catalog';
import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';

/**
 * What may stand in a table cell (issue #312).
 *
 * A database embedded in a cell ran over the cell, the table's lines crossed
 * it, and nobody can work with a database that narrow anyway. Johanna decided
 * on 2026-11-27 that it is not possible at all. The rule lives here, in one
 * place, and every way content reaches a cell asks it:
 *
 * - the schema itself: a cell's content expression names every block except
 *   the ones below (`TABLE_CELL_CONTENT`), so ProseMirror refuses one as a
 *   direct child on its own;
 * - `validateProseMirrorDocument`, which every server-side write and the
 *   finished page of a narrow write (ADR-055) go through, refuses one at any
 *   depth -- a quote or a callout inside a cell holds `block+`, which the
 *   schema cannot narrow without a second set of nodes;
 * - the slash menu (`blockCatalogAllowedAt`), the drop line
 *   (`blockDropCandidates`) and pasting (`TableCellBlocks`, which turns the
 *   database into a link to it) in the editor;
 * - the document migration of schema 7, which turns one already standing in a
 *   cell into a link to the same database.
 */

/** The nodes that are table cells. */
export const TABLE_CELL_TYPES: ReadonlySet<string> = new Set(['tableCell', 'tableHeader']);

/** Blocks that never stand inside a table cell, at any depth. */
export const BLOCKS_OUTSIDE_TABLE_CELLS: ReadonlySet<string> = new Set(['databaseEmbed']);

/**
 * Every block a cell takes as a direct child: the `block` group of the schema
 * without `BLOCKS_OUTSIDE_TABLE_CELLS`. Written out, because a content
 * expression cannot subtract; `schema.test.ts` fails when a new block is in
 * neither list, so adding one is a decision rather than an accident.
 *
 * `paragraph` comes first: a new cell is filled with the first type that can
 * be made empty.
 */
export const TABLE_CELL_BLOCKS = [
  'paragraph',
  'heading',
  'horizontalRule',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'taskList',
  'details',
  'columnList',
  'blockMath',
  'tableOfContents',
  'pageLink',
  'breadcrumb',
  'savedQueryEmbed',
  'transclusion',
  'table',
  'image',
  'fileAttachment',
  'video',
  'audio',
  'pdf',
  'embed',
  'bookmark',
  'callout',
] as const;

/** The content expression of `tableCell` and `tableHeader`. */
export const TABLE_CELL_CONTENT = `(${TABLE_CELL_BLOCKS.join(' | ')})+`;

/** Whether a position lies inside a table cell, however deep. */
export function isInsideTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (TABLE_CELL_TYPES.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

/** Whether `fragment` holds, anywhere, a block that never stands in a cell. */
export function holdsBlockOutsideTableCells(fragment: Fragment): boolean {
  let found = false;
  fragment.descendants((node) => {
    if (found) return false;
    if (BLOCKS_OUTSIDE_TABLE_CELLS.has(node.type.name)) found = true;
    return !found;
  });
  return found;
}

/** Whether `content` may be put at `$pos` as far as table cells are concerned. */
export function fitsTableCellRule($pos: ResolvedPos, content: Fragment): boolean {
  return !(isInsideTableCell($pos) && holdsBlockOutsideTableCells(content));
}

/** Whether a block of type `nodeName` may be put at `$pos`. */
export function blockAllowedAt($pos: ResolvedPos, nodeName: string): boolean {
  return !(BLOCKS_OUTSIDE_TABLE_CELLS.has(nodeName) && isInsideTableCell($pos));
}

/**
 * The catalog entries that may be inserted at `$pos`: the slash menu inside a
 * cell does not offer a database (issue #312). An entry names the node it
 * inserts with `inserts`; one that names none is always offered.
 */
export function blockCatalogAllowedAt(
  entries: readonly BlockCatalogEntry[],
  $pos: ResolvedPos,
): BlockCatalogEntry[] {
  return entries.filter(
    (entry) => entry.inserts === undefined || blockAllowedAt($pos, entry.inserts),
  );
}

/** A block found where it must not stand. */
export interface TableCellViolation {
  type: string;
  /** Its block identifier, when it has one. */
  blockId: string | null;
}

/** Every block in a cell that never stands in a cell, in document order. */
export function findBlocksInTableCells(document: ProseMirrorNode): TableCellViolation[] {
  const found: TableCellViolation[] = [];
  const visit = (node: ProseMirrorNode, inCell: boolean): void => {
    if (inCell && BLOCKS_OUTSIDE_TABLE_CELLS.has(node.type)) {
      const blockId = node.attrs?.[BLOCK_ID_ATTRIBUTE];
      found.push({ type: node.type, blockId: typeof blockId === 'string' ? blockId : null });
    }
    const below = inCell || TABLE_CELL_TYPES.has(node.type);
    for (const child of node.content ?? []) visit(child, below);
  };
  visit(document, false);
  return found;
}

/** The developer-facing sentence every refusal of the rule carries. */
export function tableCellViolationMessage(violation: TableCellViolation): string {
  return (
    `A database (${violation.type}) cannot stand inside a table cell. ` +
    'Put it above or below the table, or link to it from the cell with [[Titel]] ' +
    'or a `:::page Titel` block'
  );
}

/**
 * The attributes of a page link to the database an embed shows.
 *
 * The embed's `title` is the database's title as it was when it was chosen,
 * and its `documentId` the database; a page link carries exactly those two, so
 * the link opens the same database and is renamed with it. An embed that was
 * never bound (`documentId` empty) becomes a link by title, the way a
 * `[[Titel]]` typed before its page existed is one.
 */
export function pageLinkAttributesForEmbed(
  attrs: Readonly<Record<string, unknown>> | undefined,
  keepBlockId: boolean,
): Record<string, string | null> {
  const title = typeof attrs?.title === 'string' ? attrs.title : '';
  const documentId =
    typeof attrs?.documentId === 'string' && attrs.documentId.length > 0 ? attrs.documentId : null;
  const blockId = attrs?.[BLOCK_ID_ATTRIBUTE];
  return {
    title,
    documentId,
    ...(keepBlockId && typeof blockId === 'string' ? { [BLOCK_ID_ATTRIBUTE]: blockId } : {}),
  };
}

/**
 * Turns every block in a cell that never stands in one into a page link to
 * what it showed, and leaves everything else as it was. The JSON half of
 * schema 7; the block keeps its identifier, so a comment or a transclusion
 * aimed at it now finds the link.
 */
export function tableCellBlocksToLinks(document: ProseMirrorDocument): ProseMirrorDocument {
  const visit = (node: ProseMirrorNode, inCell: boolean): ProseMirrorNode => {
    if (inCell && BLOCKS_OUTSIDE_TABLE_CELLS.has(node.type)) {
      return { type: 'pageLink', attrs: pageLinkAttributesForEmbed(node.attrs, true) };
    }
    const children = node.content;
    if (children === undefined) return node;
    const below = inCell || TABLE_CELL_TYPES.has(node.type);
    let changed = false;
    const mapped = children.map((child) => {
      const next = visit(child, below);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...node, content: mapped } : node;
  };
  const next = visit(document, false);
  return next === document ? document : (next as ProseMirrorDocument);
}

/** `tableCellBlocksToLinks` for a fragment of live nodes, as pasting needs it. */
function linkFragment(fragment: Fragment, schema: Schema): Fragment {
  const pageLink = schema.nodes.pageLink;
  if (pageLink === undefined) return fragment;
  const nodes: PmNode[] = [];
  fragment.forEach((node) => {
    if (BLOCKS_OUTSIDE_TABLE_CELLS.has(node.type.name)) {
      // A fresh block: the database it was copied from may still stand where
      // it stood, and an identifier belongs to one block.
      nodes.push(pageLink.create(pageLinkAttributesForEmbed(node.attrs, false)));
    } else if (node.isLeaf) {
      nodes.push(node);
    } else {
      nodes.push(node.copy(linkFragment(node.content, schema)));
    }
  });
  return Fragment.fromArray(nodes);
}

/**
 * The slice as it may be pasted at `$pos`: unchanged anywhere but in a cell,
 * and there with every database turned into a link to it. Pasting is never
 * refused outright, because the rest of what was copied is still wanted, and
 * never swallows the database: the cell gets a link that opens it.
 */
export function tableCellSafeSlice(slice: Slice, $pos: ResolvedPos, schema: Schema): Slice {
  if (!isInsideTableCell($pos) || !holdsBlockOutsideTableCells(slice.content)) return slice;
  return new Slice(linkFragment(slice.content, schema), slice.openStart, slice.openEnd);
}

export const tableCellBlocksKey = new PluginKey('exocortexTableCellBlocks');

/**
 * The editor half of the rule that the schema cannot say on its own: what is
 * pasted into a cell, however deep, brings no database with it.
 */
export const TableCellBlocks = Extension.create({
  name: 'tableCellBlocks',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tableCellBlocksKey,
        props: {
          transformPasted: (slice, view) =>
            tableCellSafeSlice(slice, view.state.selection.$from, view.state.schema),
        },
      }),
    ];
  },
});
