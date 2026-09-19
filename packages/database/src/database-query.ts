import {
  ARRAY_VALUED_PROPERTY_TYPES,
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  type DatabasePropertyType,
  type DatabaseSort,
} from '@exocortex/contracts';

import { Prisma, type PrismaClient } from './client';
import {
  columnForType,
  compileDerived,
  type DatabasePropertyRef,
  type DatabaseQueryScope,
  isComputedColumn,
  isDerivedColumn,
  storedValueExpression,
} from './database-derived';

/**
 * Query engine for Notion-style database rows.
 *
 * Threat model: `propertyId` and `operator` ultimately come from client JSON.
 * They must never be concatenated into SQL text. Two defenses apply:
 *
 *  1. The zod schemas in `@exocortex/contracts` (`databaseFilterOperatorSchema`
 *     etc.) reject an unrecognized operator/type before this module ever sees
 *     it.
 *  2. This module never trusts a `propertyId` on its own: the caller must pass
 *     a `properties` map built from `DatabaseProperty` rows already loaded for
 *     *this* collection. Any `propertyId` referenced by a filter or sort that
 *     is not in that map is rejected with `UnknownDatabasePropertyError` --
 *     this closes the "reference a property from a different workspace's
 *     database" hole. Which column (`textValue`/`numberValue`/`dateValue`/
 *     `boolValue`/`jsonValue`) a condition compares against is chosen in code
 *     by `columnForType`, from the looked-up property's type -- never from the
 *     request. `Prisma.raw` is used *only* for that column name, and it is
 *     always one of five hardcoded literals.
 *
 * A ROLLUP or FORMULA property has no column at all: it compiles to a scalar
 * SQL expression instead (`database-derived.ts`), built from a configuration
 * the API validated when it was saved. Filtering and sorting on one is
 * therefore the same code path as on a stored column, with the subquery in
 * place of the column reference.
 *
 * Follows the `Prisma.sql`/`Prisma.join` raw-SQL pattern already established
 * in `packages/database/src/search.ts`.
 */

export class UnknownDatabasePropertyError extends Error {
  constructor(propertyId: string) {
    super(`Unknown property in filter or sort: ${propertyId}`);
    this.name = 'UnknownDatabasePropertyError';
  }
}

/**
 * An operator used on a property type it does not apply to, or with a malformed
 * operand. Distinct from `UnknownDatabasePropertyError` so the API can tell
 * "no such property" from "that operator makes no sense here".
 */
export class InvalidDatabaseFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDatabaseFilterError';
  }
}

const ARRAY_VALUED_TYPES = new Set<DatabasePropertyType>(ARRAY_VALUED_PROPERTY_TYPES);

function resolveProperty(propertyId: string, scope: DatabaseQueryScope): DatabasePropertyRef {
  const property = scope.properties.get(propertyId);
  if (property === undefined) throw new UnknownDatabasePropertyError(propertyId);
  return property;
}

/**
 * The SQL that stands for one property's value in the row currently being
 * filtered, sorted or read. Three shapes behind one name: a column of the
 * `document` row, a correlated lookup in `document_property_value`, or --
 * for a ROLLUP or FORMULA -- a compiled expression over other rows.
 */
export function valueExpressionFor(
  property: DatabasePropertyRef,
  scope: DatabaseQueryScope,
): Prisma.Sql {
  if (isComputedColumn(property.type)) return computedValueRef(property.type);
  if (isDerivedColumn(property.type)) return compileDerived(property, scope.schema);
  return storedValueExpression(property.id, columnForType(property.type));
}

const COMPUTED_COLUMN: Record<string, string> = {
  CREATED_TIME: 'createdAt',
  UPDATED_TIME: 'updatedAt',
  CREATED_BY: 'createdById',
  UPDATED_BY: 'updatedById',
};

function computedValueRef(type: DatabasePropertyType): Prisma.Sql {
  const column = COMPUTED_COLUMN[type];
  if (column === undefined) throw new Error(`${type} is not a computed property type`);
  return Prisma.sql`document.${Prisma.raw(`"${column}"`)}`;
}

/**
 * `overlaps`: does the property's span intersect the half-open window
 * `[from, to)`? This is the query behind a calendar view.
 *
 * Two cases, kept apart on purpose:
 *
 * - `dateEndValue IS NULL` is a point in time, not a zero-length span, so it
 *   matches when it falls *inside* the window (`>= from AND < to`).
 * - otherwise the span itself is half-open, so `[10:00, 11:00)` must *not*
 *   match the window `[11:00, 12:00)`. Hence `dateEndValue > from`, not `>=`.
 *
 * `EXISTS` rather than the scalar value expression because this is the one
 * condition that reads two columns of the same value row; the
 * `(propertyId, dateValue, dateEndValue)` index serves exactly this shape.
 */
function compileOverlapsCondition(property: DatabasePropertyRef, value: unknown): Prisma.Sql {
  if (property.type !== 'DATE') {
    throw new InvalidDatabaseFilterError(
      `Operator "overlaps" applies to DATE properties only, got ${property.type}`,
    );
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new InvalidDatabaseFilterError('Operator "overlaps" expects [fromIso, toIso]');
  }
  const parseBound = (entry: unknown): Date => {
    if (typeof entry !== 'string') {
      throw new InvalidDatabaseFilterError('Operator "overlaps" expects ISO date strings');
    }
    const parsed = new Date(entry);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidDatabaseFilterError(
        `Operator "overlaps" received an invalid date: ${entry}`,
      );
    }
    return parsed;
  };
  const from = parseBound(value[0]);
  const to = parseBound(value[1]);
  if (from > to) {
    throw new InvalidDatabaseFilterError('Operator "overlaps" expects from <= to');
  }

  return Prisma.sql`EXISTS (
    SELECT 1
    FROM "document_property_value" AS dpv
    WHERE dpv."documentId" = document.id
      AND dpv."propertyId" = ${property.id}
      AND dpv."dateValue" IS NOT NULL
      AND CASE
        WHEN dpv."dateEndValue" IS NULL
          THEN dpv."dateValue" >= ${from} AND dpv."dateValue" < ${to}
          ELSE dpv."dateValue" < ${to} AND dpv."dateEndValue" > ${from}
      END
  )`;
}

function compileCondition(
  condition: DatabaseFilterCondition,
  scope: DatabaseQueryScope,
): Prisma.Sql {
  const property = resolveProperty(condition.propertyId, scope);
  const valueRef = valueExpressionFor(property, scope);
  const isArrayValued = ARRAY_VALUED_TYPES.has(property.type);

  switch (condition.operator) {
    case 'is_empty':
      return Prisma.sql`${valueRef} IS NULL`;
    case 'is_not_empty':
      return Prisma.sql`${valueRef} IS NOT NULL`;
    case 'equals':
      // Array-valued properties compare the exact stored set; scalar
      // properties compare the value directly.
      return isArrayValued
        ? Prisma.sql`${valueRef} = ${JSON.stringify(condition.value)}::jsonb`
        : Prisma.sql`${valueRef} = ${condition.value}`;
    case 'not_equals':
      return isArrayValued
        ? Prisma.sql`(${valueRef} IS NULL OR ${valueRef} <> ${JSON.stringify(condition.value)}::jsonb)`
        : Prisma.sql`(${valueRef} IS NULL OR ${valueRef} <> ${condition.value})`;
    case 'contains':
      // Array-valued "contains" takes a single option/person/file id and
      // checks array membership; scalar "contains" is a substring match.
      return isArrayValued
        ? Prisma.sql`${valueRef} @> ${JSON.stringify([condition.value])}::jsonb`
        : Prisma.sql`${valueRef} ILIKE ${`%${String(condition.value)}%`}`;
    case 'not_contains':
      return isArrayValued
        ? Prisma.sql`NOT (${valueRef} @> ${JSON.stringify([condition.value])}::jsonb)`
        : Prisma.sql`(${valueRef} IS NULL OR ${valueRef} NOT ILIKE ${`%${String(condition.value)}%`})`;
    case 'greater_than':
      return Prisma.sql`${valueRef} > ${condition.value}`;
    case 'less_than':
      return Prisma.sql`${valueRef} < ${condition.value}`;
    case 'on_or_after':
      return Prisma.sql`${valueRef} >= ${condition.value}`;
    case 'on_or_before':
      return Prisma.sql`${valueRef} <= ${condition.value}`;
    case 'overlaps':
      return compileOverlapsCondition(property, condition.value);
  }
}

export function compileFilterGroup(
  group: DatabaseFilterGroup,
  scope: DatabaseQueryScope,
): Prisma.Sql {
  if (group.conditions.length === 0) return Prisma.sql`TRUE`;

  const combinator = group.combinator === 'or' ? ' OR ' : ' AND ';
  const parts = group.conditions.map((entry) =>
    'combinator' in entry
      ? Prisma.sql`(${compileFilterGroup(entry, scope)})`
      : compileCondition(entry, scope),
  );
  return Prisma.join(parts, combinator);
}

export function compileSorts(
  sorts: readonly DatabaseSort[],
  scope: DatabaseQueryScope,
): Prisma.Sql {
  if (sorts.length === 0) return Prisma.sql`document."orderKey" ASC`;

  const parts = sorts.map((sort) => {
    const valueRef = valueExpressionFor(resolveProperty(sort.propertyId, scope), scope);
    const direction = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    return Prisma.sql`${valueRef} ${direction} NULLS LAST`;
  });
  // Stable tiebreaker so equal sort keys keep a deterministic order.
  parts.push(Prisma.sql`document."orderKey" ASC`);
  return Prisma.join(parts, ', ');
}

export interface DatabaseQueryRowRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
  title: string;
  icon: string | null;
  iconColor: string | null;
  layout: 'NARROW' | 'WIDE' | 'FULL';
  overviewMode: 'OFF' | 'AUTO';
  coverAttachmentId: string | null;
  coverPosition: number;
  orderKey: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface DatabaseQueryInput {
  workspaceId: string;
  collectionDocumentId: string;
  scope: DatabaseQueryScope;
  filters: DatabaseFilterGroup;
  sorts: readonly DatabaseSort[];
  limit: number;
  /** Offset-based cursor, required whenever `sorts` is non-empty (see docs/database-views.md). */
  offset: number;
}

/**
 * Fetches the row `Document`s for one page of a database query. Row property
 * values are fetched separately by the caller (one `documentPropertyValue.findMany`
 * for the returned ids) rather than joined here, since a per-property JOIN for
 * every visible column would multiply the row count.
 */
export async function queryDatabaseRows(
  prisma: PrismaClient,
  input: DatabaseQueryInput,
): Promise<DatabaseQueryRowRecord[]> {
  const filterSql = compileFilterGroup(input.filters, input.scope);
  const orderSql = compileSorts(input.sorts, input.scope);

  return prisma.$queryRaw<DatabaseQueryRowRecord[]>(Prisma.sql`
    SELECT
      document.id, document."workspaceId", document."parentId", document."type"::text AS "type",
      document.title, document.icon, document."iconColor", document."layout"::text AS "layout",
      document."overviewMode"::text AS "overviewMode",
      document."coverAttachmentId", document."coverPosition",
      document."orderKey", document."createdById", document."updatedById",
      document."createdAt", document."updatedAt", document."archivedAt"
    FROM "document" AS document
    WHERE document."workspaceId" = ${input.workspaceId}
      AND document."parentId" = ${input.collectionDocumentId}
      AND document."archivedAt" IS NULL
      AND (${filterSql})
    ORDER BY ${orderSql}
    LIMIT ${input.limit}
    OFFSET ${input.offset}
  `);
}

/**
 * The values of the ROLLUP and FORMULA properties of a set of rows.
 *
 * A second statement rather than extra columns on `queryDatabaseRows`, because
 * the two reads that need it disagree about everything else: the list view
 * fetches a page of rows through the filter compiler, and the row endpoint
 * fetches exactly one row by id. Both end up here with a list of ids they have
 * already authorized, which is also why this query does not take a workspace:
 * it never decides what may be read, it only computes.
 */
export async function queryDerivedValues(
  prisma: PrismaClient,
  input: {
    documentIds: readonly string[];
    derived: readonly DatabasePropertyRef[];
    scope: DatabaseQueryScope;
  },
): Promise<Map<string, Map<string, unknown>>> {
  const result = new Map<string, Map<string, unknown>>();
  if (input.documentIds.length === 0 || input.derived.length === 0) return result;

  // Aliases are generated here, never taken from a request: `d0`, `d1`, …
  const aliases = input.derived.map((property, index) => ({ property, alias: `d${index}` }));
  const columns = Prisma.join(
    aliases.map(
      ({ property, alias }) =>
        Prisma.sql`${compileDerived(property, input.scope.schema)} AS ${Prisma.raw(`"${alias}"`)}`,
    ),
    ', ',
  );

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT document.id AS "rowId", ${columns}
    FROM "document" AS document
    WHERE document.id IN (${Prisma.join([...input.documentIds], ', ')})
  `);

  for (const row of rows) {
    const rowId = row.rowId;
    if (typeof rowId !== 'string') continue;
    const values = new Map<string, unknown>();
    for (const { property, alias } of aliases) values.set(property.id, row[alias] ?? null);
    result.set(rowId, values);
  }
  return result;
}
