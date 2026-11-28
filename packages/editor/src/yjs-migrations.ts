import * as Y from 'yjs';

import { migrateCalloutsInYjsDoc } from './callout-yjs';
import { migrateTableCellBlocksInYjsDoc } from './table-cell-yjs';
import { yjsStateToDocument } from './yjs';

/**
 * Every document migration that rewrites the canonical Yjs state, in version
 * order, as one call (docs/editor-extensions.md, "Document migrations").
 *
 * The collaboration server applies it to each page it opens and
 * `documents:migrate` to every stored page; both are idempotent, so adding a
 * step here is all a new migration of the stored state needs to reach both.
 */
export interface YjsDocMigration {
  /** Schema 6 (issue #306): callouts whose variant became a symbol and a colour. */
  callouts: number;
  /** Schema 7 (issue #312): databases in table cells that became links. */
  tableCellBlocks: number;
}

/** How many elements a migration changed in all. */
export function migratedElements(migration: YjsDocMigration): number {
  return migration.callouts + migration.tableCellBlocks;
}

/** Brings a live Yjs document to the current schema, in place. */
export function migrateYjsDoc(doc: Y.Doc, origin: unknown = null): YjsDocMigration {
  return {
    callouts: migrateCalloutsInYjsDoc(doc, origin),
    tableCellBlocks: migrateTableCellBlocksInYjsDoc(doc, origin),
  };
}

export interface YjsStateMigration extends YjsDocMigration {
  /** The migrated state, or `null` when nothing had to change. */
  yjsState: Uint8Array | null;
}

/** `migrateYjsDoc` for a stored binary state. */
export function migrateYjsState(state: Uint8Array): YjsStateMigration {
  const doc = yjsStateToDocument(state);
  try {
    const migration = migrateYjsDoc(doc);
    return {
      ...migration,
      yjsState: migratedElements(migration) === 0 ? null : Y.encodeStateAsUpdate(doc),
    };
  } finally {
    doc.destroy();
  }
}
