// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { Fragment, type Node as PmNode, Slice } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { prosemirrorJSONToYDoc } from 'y-prosemirror';
import * as Y from 'yjs';

import { blockDropCandidates } from './block-drop';
import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { applyBlockRangeEditToState, BlockRangeError } from './block-range';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildBlockCatalog, buildEditorExtensions } from './extensions';
import { parseMarkdown } from './markdown';
import { migrateDocument } from './migrations';
import {
  getExocortexSchema,
  repairProseMirrorDocument,
  validateProseMirrorDocument,
} from './schema';
import {
  blockCatalogAllowedAt,
  BLOCKS_OUTSIDE_TABLE_CELLS,
  findBlocksInTableCells,
  TABLE_CELL_BLOCKS,
  tableCellBlocksToLinks,
  tableCellSafeSlice,
} from './table-cell-blocks';
import { migrateTableCellBlocksInYjsDoc } from './table-cell-yjs';
import { proseMirrorJsonToYjsState, yDocToProseMirrorJson, YJS_DOCUMENT_FIELD } from './yjs';
import { migrateYjsState } from './yjs-migrations';

/** Issue #312: no database in a table cell, on every way in. */

const EMBED: ProseMirrorNode = {
  type: 'databaseEmbed',
  attrs: {
    documentId: 'db1',
    title: 'Aufgaben',
    viewId: null,
    [BLOCK_ID_ATTRIBUTE]: 'embedaaaaaa1',
  },
};

function paragraph(text: string, blockId?: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    ...(blockId === undefined ? {} : { attrs: { [BLOCK_ID_ATTRIBUTE]: blockId } }),
    content: [{ type: 'text', text }],
  };
}

/** A one-row table whose only cell holds `cell`. */
function tableWith(...cell: ProseMirrorNode[]): ProseMirrorNode {
  return {
    type: 'table',
    attrs: { [BLOCK_ID_ATTRIBUTE]: 'tableaaaaaa1' },
    content: [
      {
        type: 'tableRow',
        content: [{ type: 'tableCell', content: cell }],
      },
    ],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

const IN_CELL = doc(tableWith(paragraph('Zelle'), EMBED));
const IN_QUOTE_IN_CELL = doc(tableWith({ type: 'blockquote', content: [EMBED] }));

/**
 * A stored state that holds what the schema no longer allows, the way a page
 * written before schema 7 does. `proseMirrorJsonToYjsState` validates and
 * would refuse it; y-prosemirror alone does not.
 */
function legacyState(document: ProseMirrorDocument): Y.Doc {
  return prosemirrorJSONToYDoc(getExocortexSchema(), document, YJS_DOCUMENT_FIELD);
}

describe('the schema', () => {
  it('refuses a database in a table cell, as a child and deeper, with a sentence', () => {
    for (const document of [IN_CELL, IN_QUOTE_IN_CELL]) {
      const result = validateProseMirrorDocument(document);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot stand inside a table cell');
    }
    expect(validateProseMirrorDocument(doc(EMBED, tableWith(paragraph('Zelle')))).valid).toBe(true);
  });

  it('refuses a database as a cell child on its own, without the rule in front of it', () => {
    const cell = getExocortexSchema().nodes.tableCell;
    const embed = getExocortexSchema().nodeFromJSON(EMBED);
    const text = getExocortexSchema().nodeFromJSON(paragraph('Zelle'));
    expect(cell?.validContent(Fragment.from(text))).toBe(true);
    expect(cell?.validContent(Fragment.from(embed))).toBe(false);
  });

  it('lets a cell hold every block except the ones kept out of cells', () => {
    // The gate for a new block: it is either allowed in a cell or kept out on
    // purpose, never forgotten.
    const blocks = Object.values(getExocortexSchema().nodes)
      .filter((type) => (type.spec.group ?? '').split(' ').includes('block'))
      .map((type) => type.name)
      .filter((name) => !BLOCKS_OUTSIDE_TABLE_CELLS.has(name))
      .sort();
    expect([...TABLE_CELL_BLOCKS].sort()).toEqual(blocks);
  });

  it('fills a new cell with a paragraph', () => {
    const cell = getExocortexSchema().nodes.tableCell?.createAndFill();
    expect(cell?.firstChild?.type.name).toBe('paragraph');
  });
});

describe('schema 7', () => {
  it('finds the database in a cell, however deep', () => {
    expect(findBlocksInTableCells(IN_CELL)).toEqual([
      { type: 'databaseEmbed', blockId: 'embedaaaaaa1' },
    ]);
    expect(findBlocksInTableCells(IN_QUOTE_IN_CELL)).toHaveLength(1);
    expect(findBlocksInTableCells(doc(EMBED))).toEqual([]);
  });

  it('turns a database in a cell into a link to it, and leaves one outside alone', () => {
    const migrated = tableCellBlocksToLinks(doc(EMBED, tableWith(paragraph('Zelle'), EMBED)));
    expect(migrated.content?.[0]).toBe(EMBED);
    const cell = migrated.content?.[1]?.content?.[0]?.content?.[0];
    expect(cell?.content?.[1]).toEqual({
      type: 'pageLink',
      attrs: { title: 'Aufgaben', documentId: 'db1', [BLOCK_ID_ATTRIBUTE]: 'embedaaaaaa1' },
    });
    expect(validateProseMirrorDocument(migrated).valid).toBe(true);
    // Nothing to do is free: the same document comes back.
    const clean = doc(EMBED);
    expect(tableCellBlocksToLinks(clean)).toBe(clean);
  });

  it('is the migration from version 6', () => {
    const { document, applied } = migrateDocument(IN_QUOTE_IN_CELL, 6);
    expect(applied).toHaveLength(1);
    expect(findBlocksInTableCells(document)).toEqual([]);
    expect(validateProseMirrorDocument(document).valid).toBe(true);
  });

  it('links an embed that was never bound by its title', () => {
    const unbound = { ...EMBED, attrs: { documentId: '', title: 'Ohne', viewId: null } };
    const migrated = tableCellBlocksToLinks(doc(tableWith(unbound)));
    expect(migrated.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]).toEqual({
      type: 'pageLink',
      attrs: { title: 'Ohne', documentId: null },
    });
  });

  it('rewrites the stored Yjs state in place, once', () => {
    const live = legacyState(doc(paragraph('Vor', 'paraaaaaaaa1'), tableWith(EMBED)));
    expect(migrateTableCellBlocksInYjsDoc(live)).toBe(1);
    expect(migrateTableCellBlocksInYjsDoc(live)).toBe(0);
    const after = yDocToProseMirrorJson(live);
    expect(validateProseMirrorDocument(after).valid).toBe(true);
    const link = after.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0];
    expect(link?.type).toBe('pageLink');
    expect(link?.attrs).toMatchObject({
      title: 'Aufgaben',
      documentId: 'db1',
      [BLOCK_ID_ATTRIBUTE]: 'embedaaaaaa1',
    });
    // The paragraph before it is the same element, not a rebuilt copy.
    expect(after.content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE]).toBe('paraaaaaaaa1');
    live.destroy();
  });

  it('migrates a stored state with every step, and leaves a clean one unwritten', () => {
    const live = legacyState(IN_QUOTE_IN_CELL);
    const result = migrateYjsState(Y.encodeStateAsUpdate(live));
    live.destroy();
    expect(result.tableCellBlocks).toBe(1);
    expect(result.yjsState).not.toBeNull();
    const again = migrateYjsState(result.yjsState ?? new Uint8Array());
    expect(again).toEqual({ callouts: 0, tableCellBlocks: 0, yjsState: null });
  });

  it('repairs a database in a cell into a link rather than dropping the cell', () => {
    const repaired = repairProseMirrorDocument(IN_CELL);
    expect(validateProseMirrorDocument(repaired).valid).toBe(true);
    expect(JSON.stringify(repaired)).toContain('"pageLink"');
    expect(JSON.stringify(repaired)).toContain('Zelle');
  });
});

describe('narrow writes (ADR-055)', () => {
  const page = doc(
    paragraph('Oben', 'paraaaaaaaa1'),
    tableWith(paragraph('Zelle', 'cellparaaaa1')),
  );

  it('refuses a database aimed into a cell by name', () => {
    const embed = parseMarkdown(':::database-embed Aufgaben\n:::\n').document;
    let caught: unknown = null;
    try {
      applyBlockRangeEditToState(proseMirrorJsonToYjsState(page), embed, {
        fromBlockId: 'cellparaaaa1',
        toBlockId: null,
        placement: 'after',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlockRangeError);
    expect((caught as BlockRangeError).reason).toBe('database_in_table_cell');
    expect((caught as BlockRangeError).message).toContain('[[Titel]]');
  });

  it('takes the same database beside the table, and a link to it in the cell', () => {
    const embed = parseMarkdown(':::database-embed Aufgaben\n:::\n').document;
    const beside = applyBlockRangeEditToState(proseMirrorJsonToYjsState(page), embed, {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: null,
      placement: 'after',
    });
    expect(beside.proseMirrorJson.content?.[1]?.type).toBe('databaseEmbed');

    const link = parseMarkdown(':::page Aufgaben\n:::\n').document;
    const inCell = applyBlockRangeEditToState(proseMirrorJsonToYjsState(page), link, {
      fromBlockId: 'cellparaaaa1',
      toBlockId: null,
      placement: 'after',
    });
    expect(JSON.stringify(inCell.proseMirrorJson)).toContain('"pageLink"');
  });
});

describe('the editor', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function open(html: string): Editor {
    editor = new Editor({ extensions: buildEditorExtensions(), content: html });
    return editor;
  }

  /** The position inside the text block whose text is `text`. */
  function inside(node: PmNode, text: string): number {
    let found = -1;
    node.descendants((child, pos) => {
      if (found >= 0) return false;
      if (child.isTextblock && child.textContent === text) found = pos + 1;
      return found < 0;
    });
    expect(found).toBeGreaterThan(0);
    return found;
  }

  const TABLE = '<p>Oben</p><table><tbody><tr><td><p>Zelle</p></td></tr></tbody></table>';

  it('does not offer a database in the slash menu inside a cell', () => {
    const { state } = open(TABLE);
    const catalog = buildBlockCatalog();
    const inCell = blockCatalogAllowedAt(catalog, state.doc.resolve(inside(state.doc, 'Zelle')));
    const outside = blockCatalogAllowedAt(catalog, state.doc.resolve(inside(state.doc, 'Oben')));
    expect(inCell.map((entry) => entry.id)).not.toContain('database-embed');
    expect(inCell.map((entry) => entry.id)).toContain('page-link');
    expect(outside.map((entry) => entry.id)).toContain('database-embed');
    expect(outside).toHaveLength(catalog.length);
  });

  it('refuses to insert a database in a cell even when asked directly', () => {
    const instance = open(TABLE);
    instance.commands.setTextSelection(inside(instance.state.doc, 'Zelle'));
    const entry = buildBlockCatalog().find((candidate) => candidate.id === 'database-embed');
    expect(entry?.run(instance, JSON.stringify({ documentId: 'db1', title: 'Aufgaben' }))).toBe(
      false,
    );
    expect(JSON.stringify(instance.getJSON())).not.toContain('databaseEmbed');
  });

  it('pastes a database into a cell as a link to it, and elsewhere as itself', () => {
    const instance = open(TABLE);
    const { schema, doc: current } = instance.state;
    const embed = schema.nodeFromJSON(EMBED);
    const slice = new Slice(Fragment.from(embed), 0, 0);

    const inCell = tableCellSafeSlice(slice, current.resolve(inside(current, 'Zelle')), schema);
    expect(inCell.content.firstChild?.type.name).toBe('pageLink');
    expect(inCell.content.firstChild?.attrs).toMatchObject({
      title: 'Aufgaben',
      documentId: 'db1',
    });
    // A fresh block: the copied database may still stand where it stood.
    expect(inCell.content.firstChild?.attrs[BLOCK_ID_ATTRIBUTE]).not.toBe('embedaaaaaa1');

    const outside = tableCellSafeSlice(slice, current.resolve(inside(current, 'Oben')), schema);
    expect(outside).toBe(slice);
  });

  it('offers no drop place inside a cell for a database', () => {
    const instance = open(
      '<p>Oben</p><table><tbody><tr><td><p>Zelle</p></td></tr></tbody></table>',
    );
    const { schema, doc: current } = instance.state;
    const embed = Fragment.from(schema.nodeFromJSON(EMBED));
    const text = Fragment.from(schema.nodeFromJSON(paragraph('Neu')));
    // The gap around the cell's paragraph, inside the cell.
    const at = inside(current, 'Zelle') - 1;
    const gap = { from: at, to: at };
    const source = { from: 0, to: 0 };
    expect(blockDropCandidates(current, gap, embed, source, null)).toEqual([]);
    expect(blockDropCandidates(current, gap, text, source, null)).toHaveLength(1);
  });
});
