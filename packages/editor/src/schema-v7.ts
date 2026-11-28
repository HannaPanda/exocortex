import { type DocumentMigration, type ProseMirrorDocument } from './contract';
import { tableCellBlocksToLinks } from './table-cell-blocks';

/**
 * Schema version 7 takes databases out of table cells (issue #312).
 *
 * From this version on a table cell holds no database, at any depth
 * (`table-cell-blocks.ts`). One that already stands in a cell is not dropped:
 * it becomes a page link to the same database, with the same title and the
 * same block identifier, so the cell still opens what it showed.
 *
 * Two forms of the same step, as with schema 6. The JSON migration serves
 * `migrateDocument`, for a snapshot or a diff read from an older state. The
 * Yjs one (`migrateTableCellBlocksInYjsDoc`) rewrites a stored state in
 * place, so the canonical state keeps its history and nothing is rebuilt from
 * a derived form (ADR-004/005); the collaboration server applies it to every
 * page it loads, and `documents:migrate` to every page at once.
 */
export const SCHEMA_V7_MIGRATION: DocumentMigration = {
  fromVersion: 6,
  toVersion: 7,
  description: 'schema 7: a database in a table cell becomes a link to that database',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument => tableCellBlocksToLinks(document),
};
