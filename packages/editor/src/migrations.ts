import {
  type DocumentMigration,
  EXOCORTEX_SCHEMA_VERSION,
  type ProseMirrorDocument,
} from './contract';
import { collectMigrations } from './extensions';

export class DocumentMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentMigrationError';
  }
}

export interface MigrationResult {
  document: ProseMirrorDocument;
  fromVersion: number;
  toVersion: number;
  applied: string[];
}

/**
 * Applies every registered migration needed to bring a stored document up to
 * `EXOCORTEX_SCHEMA_VERSION`.
 *
 * There are no migrations yet (the schema is at version 1). The machinery exists
 * so the first schema change is a data change, not an architecture change; see
 * docs/editor-extensions.md for the workflow.
 */
export function migrateDocument(
  document: ProseMirrorDocument,
  fromVersion: number,
  migrations: readonly DocumentMigration[] = collectMigrations(),
): MigrationResult {
  if (fromVersion > EXOCORTEX_SCHEMA_VERSION) {
    throw new DocumentMigrationError(
      `Document schema version ${fromVersion} is newer than this build supports ` +
        `(${EXOCORTEX_SCHEMA_VERSION}). Refusing to downgrade.`,
    );
  }

  let current = document;
  let version = fromVersion;
  const applied: string[] = [];

  // Deterministic: at most one migration per version step.
  while (version < EXOCORTEX_SCHEMA_VERSION) {
    const migration = migrations.find((candidate) => candidate.fromVersion === version);
    if (migration === undefined) {
      throw new DocumentMigrationError(
        `No migration registered from schema version ${version} to ${version + 1}`,
      );
    }
    current = migration.migrate(current);
    applied.push(migration.description);
    version = migration.toVersion;
  }

  return { document: current, fromVersion, toVersion: version, applied };
}

/** `true` when a stored document needs migration before being used. */
export function needsMigration(schemaVersion: number): boolean {
  return schemaVersion < EXOCORTEX_SCHEMA_VERSION;
}
