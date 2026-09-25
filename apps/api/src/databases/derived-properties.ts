import {
  DATABASE_RELATION_MAX_TARGETS,
  databaseFormulaPropertyConfigSchema,
  type DatabasePropertyType,
  databaseRelationPropertyConfigSchema,
  databaseRollupPropertyConfigSchema,
  type DatabaseRowPropertyValue,
  FormulaError,
  parseRelationConfig,
} from '@exocortex/contracts';
import {
  compileDerived,
  type DatabasePropertyRef,
  type DatabaseQueryScope,
  derivedPropertiesOf,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * The API's half of RELATION, ROLLUP and FORMULA (issue #76).
 *
 * Assembling the schema a derived column may look at is `loadDatabaseScope` in
 * `@exocortex/database`, because the worker needs it too. What lives here is
 * the part that decides: refusing a configuration that does not describe a
 * column, and checking the ids a relation points at. Both happen when
 * something is *written*, so a read never has to cope with a column that
 * cannot be computed.
 */

export function toDerivedRef(row: {
  id: string;
  documentId: string;
  type: DatabasePropertyType;
  name: string;
  config: unknown;
}): DatabasePropertyRef {
  return {
    id: row.id,
    documentId: row.documentId,
    type: row.type,
    name: row.name,
    config: (row.config ?? null) as Record<string, unknown> | null,
  };
}

/** Placeholder id for a property that is being validated before it is created. */
export const PENDING_PROPERTY_ID = '__pending__';

/**
 * Proves every derived column of this database still compiles.
 *
 * Run after every schema change rather than only on the property being
 * touched: renaming a column breaks the formula that names it, and deleting
 * one breaks the rollup that aggregates over it. Finding that out here is a
 * refused request; finding it out on the next read would be a database nobody
 * can open.
 */
export function assertDerivedPropertiesCompile(
  scope: DatabaseQueryScope,
  /**
   * `database_property_in_use` when the change was a removal: the
   * configuration is not wrong, it just lost the column it stood on, and the
   * two read very differently to whoever pressed the button.
   */
  code:
    | 'database_property_config_invalid'
    | 'database_property_in_use' = 'database_property_config_invalid',
): void {
  for (const property of derivedPropertiesOf(scope)) {
    try {
      compileDerived(property, scope.schema);
    } catch (error) {
      // `DerivedPropertyError` is a `FormulaError`, so one branch serves both.
      // The column is named because it need not be the one being edited: a
      // rename breaks the formula that names it. `reason` is the code an agent
      // reads (describeApiError), `formula` what the browser renders from
      // `database.formulaErrors` in its reader's language.
      if (error instanceof FormulaError) {
        throw new AppError(code, `Column "${property.name ?? property.id}": ${error.message}`, {
          reason: error.code,
          formula: {
            ...error.detail,
            propertyId: property.id,
            propertyName: property.name ?? null,
          },
        });
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration of a single property
// ---------------------------------------------------------------------------

/**
 * Validates the `config` of a RELATION, ROLLUP or FORMULA property and returns
 * the parsed bag to store. Shape only; whether it makes sense together with
 * the rest of the database is `assertDerivedPropertiesCompile`'s question.
 */
export async function normalizeDerivedConfig(input: {
  prisma: PrismaClient;
  type: DatabasePropertyType;
  config: Record<string, unknown> | null | undefined;
  collectionDocumentId: string;
  workspaceId: string;
}): Promise<Record<string, unknown>> {
  if (input.config === null || input.config === undefined) {
    throw AppError.validation(`A column of type ${input.type} needs a configuration`);
  }
  if (input.type === 'RELATION') {
    const parsed = databaseRelationPropertyConfigSchema.safeParse(input.config);
    if (!parsed.success) {
      throw AppError.validation('A relation needs { targetCollectionId, allowMultiple }');
    }
    await assertRelationTargetIsReachable({
      prisma: input.prisma,
      targetCollectionId: parsed.data.targetCollectionId,
      workspaceId: input.workspaceId,
    });
    return { ...parsed.data };
  }
  if (input.type === 'ROLLUP') {
    const parsed = databaseRollupPropertyConfigSchema.safeParse(input.config);
    if (!parsed.success) {
      throw AppError.validation(
        'A rollup needs { relationPropertyId, targetPropertyId, aggregate }',
      );
    }
    return { ...parsed.data };
  }
  const parsed = databaseFormulaPropertyConfigSchema.safeParse(input.config);
  if (!parsed.success) {
    throw AppError.validation('A formula column needs { expression }');
  }
  return { ...parsed.data };
}

/**
 * A relation may only point at a database in the *same* workspace.
 *
 * This is the whole of "relations must not leak access to their targets".
 * Authorization here is per workspace and per document, so a relation across
 * that boundary would let a member of one workspace learn which row ids exist
 * in another -- and a rollup over it would hand them the numbers as well. A
 * relation inside the workspace tells its reader nothing they could not read
 * by opening the target database, and the value itself is ids, never titles:
 * every title a client shows was fetched through an authorized read of its own.
 */
async function assertRelationTargetIsReachable(input: {
  prisma: PrismaClient;
  targetCollectionId: string;
  workspaceId: string;
}): Promise<void> {
  const target = await input.prisma.document.findUnique({
    where: { id: input.targetCollectionId },
    select: { type: true, workspaceId: true, archivedAt: true },
  });
  if (target === null || target.archivedAt !== null || target.type !== 'COLLECTION') {
    throw AppError.validation('The target of a relation must be a database');
  }
  if (target.workspaceId !== input.workspaceId) {
    throw AppError.validation('The target of a relation must be in the same workspace');
  }
}

// ---------------------------------------------------------------------------
// Relation values
// ---------------------------------------------------------------------------

/**
 * Checks the ids one relation value points at, and returns them de-duplicated
 * in the order they were sent.
 *
 * Every id has to be a live row of the relation's own target database. An id
 * that is not gets the write refused rather than stored: a dangling link is
 * invisible in the table and only shows up as a rollup that quietly counts
 * wrong, which is the worst way for a mistake to surface.
 */
export async function normalizeRelationValue(input: {
  prisma: PrismaClient;
  property: DatabasePropertyRef;
  value: DatabaseRowPropertyValue['value'];
}): Promise<string[]> {
  const config = parseRelationConfig(input.property.config);
  if (config === null) {
    throw AppError.validation(`Relation ${input.property.id} is not configured`);
  }
  if (!Array.isArray(input.value)) {
    throw AppError.validation(`Column ${input.property.id} expects a list of row ids`);
  }
  const ids = [...new Set(input.value.map(String))];
  if (ids.length === 0) return ids;
  if (!config.allowMultiple && ids.length > 1) {
    throw AppError.validation(`Column ${input.property.id} links at most one row`);
  }
  if (ids.length > DATABASE_RELATION_MAX_TARGETS) {
    throw AppError.validation(`A relation holds at most ${DATABASE_RELATION_MAX_TARGETS} rows`);
  }

  const found = await input.prisma.document.findMany({
    where: { id: { in: ids }, parentId: config.targetCollectionId, archivedAt: null },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    throw AppError.validation(
      `These rows do not belong to the related database: ${missing.join(', ')}`,
    );
  }
  return ids;
}
