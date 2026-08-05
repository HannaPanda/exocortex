import { type DocumentMigration, type ProseMirrorDocument } from './contract';

/**
 * Schema version 2 introduces the full block set: inline styling marks, toggles,
 * columns, mathematics, a table of contents, page links, media and embeds.
 *
 * Every addition is purely additive, so a version 1 document is already a valid
 * version 2 document and the migration is an identity. It exists because
 * `migrateDocument` requires exactly one migration per version step, which keeps
 * the upgrade path explicit and auditable instead of silently permissive.
 */
export const SCHEMA_V2_MIGRATION: DocumentMigration = {
  fromVersion: 1,
  toVersion: 2,
  description: 'schema 2: full block set (inline styling, toggle, columns, math, media, embeds)',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument => document,
};
