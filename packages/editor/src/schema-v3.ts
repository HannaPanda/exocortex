import { type DocumentMigration, type ProseMirrorDocument } from './contract';

/**
 * Schema version 3 adds the database embed (Notion's "linked database view").
 *
 * Purely additive, so a version 2 document is already valid version 3 and the
 * migration is an identity — see `SCHEMA_V2_MIGRATION` for why this exists
 * anyway.
 */
export const SCHEMA_V3_MIGRATION: DocumentMigration = {
  fromVersion: 2,
  toVersion: 3,
  description: 'schema 3: database embed (linked database view)',
  migrate: (document: ProseMirrorDocument): ProseMirrorDocument => document,
};
