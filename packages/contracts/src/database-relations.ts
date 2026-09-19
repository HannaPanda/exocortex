import { z } from 'zod';

import {
  compileFormulaSource,
  type FormulaPropertyResolver,
  type FormulaValueType,
} from './database-formula';
import { idSchema } from './primitives';

/**
 * Configuration of the three linked property types (issue #76).
 *
 * All three are *derived*: a RELATION stores ids and nothing else, a ROLLUP
 * and a FORMULA store nothing at all. That is the rule they exist under -- a
 * computed column must never become a second canonical state, so it is
 * recomputed by the query engine on every read rather than written back into
 * `DocumentPropertyValue` (ADR-041).
 */

// ---------------------------------------------------------------------------
// RELATION
// ---------------------------------------------------------------------------

/**
 * A RELATION property's `config`.
 *
 * `targetCollectionId` is a database in the *same workspace*, checked when the
 * config is written rather than when a row is read: authorization in this
 * system is per workspace and per document, so a relation that could point
 * across a workspace boundary would be a way to learn which ids exist over
 * there. A self-relation (target = the property's own database) is allowed and
 * is how a task gets sub-tasks.
 *
 * The value of the property is an array of row document ids -- the same
 * `jsonValue` shape MULTI_SELECT, PERSON and FILES already use, which is why
 * `contains`, `is_empty` and friends work on it without a new operator.
 */
export const databaseRelationPropertyConfigSchema = z.object({
  targetCollectionId: idSchema,
  /** False pins the property to at most one linked row. */
  allowMultiple: z.boolean().default(true),
});
export type DatabaseRelationPropertyConfig = z.infer<typeof databaseRelationPropertyConfigSchema>;

export function parseRelationConfig(
  config: Record<string, unknown> | null | undefined,
): DatabaseRelationPropertyConfig | null {
  const parsed = databaseRelationPropertyConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : null;
}

/** How many linked rows one relation value may hold. A ceiling, not a setting. */
export const DATABASE_RELATION_MAX_TARGETS = 100;

// ---------------------------------------------------------------------------
// ROLLUP
// ---------------------------------------------------------------------------

/**
 * The aggregates a rollup offers. Deliberately the small set from the issue:
 * every one of them is a single SQL aggregate over the linked rows, so none of
 * them needs a second pass in application code.
 */
export const DATABASE_ROLLUP_AGGREGATES = [
  'count',
  'count_unique',
  'count_not_empty',
  'sum',
  'average',
  'min',
  'max',
  'earliest',
  'latest',
] as const;
export const databaseRollupAggregateSchema = z.enum(DATABASE_ROLLUP_AGGREGATES);
export type DatabaseRollupAggregate = z.infer<typeof databaseRollupAggregateSchema>;

/** Aggregates that read only the *number* of linked rows, so they need no target column. */
export const ROLLUP_AGGREGATES_WITHOUT_TARGET = [
  'count',
] as const satisfies readonly DatabaseRollupAggregate[];

export const databaseRollupPropertyConfigSchema = z.object({
  /** A RELATION property of the *same* database. */
  relationPropertyId: idSchema,
  /** A property of the relation's target database. Null only for `count`. */
  targetPropertyId: idSchema.nullable().default(null),
  aggregate: databaseRollupAggregateSchema,
});
export type DatabaseRollupPropertyConfig = z.infer<typeof databaseRollupPropertyConfigSchema>;

export function parseRollupConfig(
  config: Record<string, unknown> | null | undefined,
): DatabaseRollupPropertyConfig | null {
  const parsed = databaseRollupPropertyConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : null;
}

/** What a rollup answers with, which is what a formula reading it sees. */
export function rollupResultType(aggregate: DatabaseRollupAggregate): FormulaValueType {
  if (aggregate === 'earliest' || aggregate === 'latest') return 'date';
  return 'number';
}

// ---------------------------------------------------------------------------
// FORMULA
// ---------------------------------------------------------------------------

export const databaseFormulaPropertyConfigSchema = z.object({
  /** Source text in the language of `database-formula.ts`. */
  expression: z.string().trim().min(1).max(2000),
});
export type DatabaseFormulaPropertyConfig = z.infer<typeof databaseFormulaPropertyConfigSchema>;

export function parseFormulaConfig(
  config: Record<string, unknown> | null | undefined,
): DatabaseFormulaPropertyConfig | null {
  const parsed = databaseFormulaPropertyConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : null;
}

/**
 * Validates a formula against the database it belongs to and reports the type
 * it produces. The same call the API makes before storing a config and the
 * browser makes while somebody types, so the error text is identical in both.
 */
export function validateFormulaConfig(
  expression: string,
  resolve: FormulaPropertyResolver,
): FormulaValueType {
  return compileFormulaSource(expression, resolve).type;
}
