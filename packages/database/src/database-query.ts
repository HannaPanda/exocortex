import {
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  type DatabasePropertyType,
  type DatabaseSort,
} from '@exocortex/contracts';

import { Prisma, type PrismaClient } from './client';

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
 *     is not in that map is rejected with `UnknownDatabasePropertyError` —
 *     this closes the "reference a property from a different workspace's
 *     database" hole. Which column (`textValue`/`numberValue`/`dateValue`/
 *     `boolValue`/`jsonValue`) a condition compares against is chosen in code
 *     by `columnForType`, from the looked-up property's type — never from the
 *     request. `Prisma.raw` is used *only* for that column name, and it is
 *     always one of five hardcoded literals.
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

export interface DatabasePropertyRef {
  id: string;
  type: DatabasePropertyType;
  /**
   * Type-specific configuration bag. Optional because the filter and sort
   * compiler never needs it; the row serializer does, to know whether a DATE
   * property is a span. Absent and null both mean "defaults".
   */
  config?: Record<string, unknown> | null;
}

export type DatabasePropertyMap = ReadonlyMap<string, DatabasePropertyRef>;

export function buildPropertyMap(properties: readonly DatabasePropertyRef[]): DatabasePropertyMap {
  return new Map(properties.map((property) => [property.id, property]));
}

type ValueColumn = 'textValue' | 'numberValue' | 'dateValue' | 'boolValue' | 'jsonValue';

/**
 * Code-chosen, never request-chosen. This is the one function allowed to
 * produce the string handed to `Prisma.raw` below.
 */
function columnForType(type: DatabasePropertyType): ValueColumn {
  switch (type) {
    case 'NUMBER':
      return 'numberValue';
    case 'DATE':
      return 'dateValue';
    case 'CHECKBOX':
      return 'boolValue';
    case 'MULTI_SELECT':
    case 'PERSON':
    case 'FILES':
      return 'jsonValue';
    case 'TEXT':
    case 'SELECT':
    case 'URL':
    case 'EMAIL':
    case 'PHONE':
      return 'textValue';
    case 'CREATED_TIME':
    case 'UPDATED_TIME':
    case 'CREATED_BY':
    case 'UPDATED_BY':
    case 'RELATION':
    case 'ROLLUP':
    case 'FORMULA':
      throw new Error(`${type} has no document_property_value column`);
  }
}

function resolveProperty(propertyId: string, properties: DatabasePropertyMap): DatabasePropertyRef {
  const property = properties.get(propertyId);
  if (property === undefined) throw new UnknownDatabasePropertyError(propertyId);
  return property;
}

/** One correlated subquery per condition: the value of `propertyId` for the row currently being filtered. */
function valueSubquery(propertyId: string, column: ValueColumn): Prisma.Sql {
  return Prisma.sql`(
    SELECT dpv.${Prisma.raw(`"${column}"`)}
    FROM "document_property_value" AS dpv
    WHERE dpv."documentId" = document.id AND dpv."propertyId" = ${propertyId}
  )`;
}

function isComputedColumn(type: DatabasePropertyType): boolean {
  return (
    type === 'CREATED_TIME' ||
    type === 'UPDATED_TIME' ||
    type === 'CREATED_BY' ||
    type === 'UPDATED_BY'
  );
}

const COMPUTED_COLUMN: Record<
  'CREATED_TIME' | 'UPDATED_TIME' | 'CREATED_BY' | 'UPDATED_BY',
  string
> = {
  CREATED_TIME: 'createdAt',
  UPDATED_TIME: 'updatedAt',
  CREATED_BY: 'createdById',
  UPDATED_BY: 'updatedById',
};

function computedValueRef(type: DatabasePropertyType): Prisma.Sql {
  const column = COMPUTED_COLUMN[type as keyof typeof COMPUTED_COLUMN];
  return Prisma.sql`document.${Prisma.raw(`"${column}"`)}`;
}

const ARRAY_VALUED_TYPES = new Set<DatabasePropertyType>(['MULTI_SELECT', 'PERSON', 'FILES']);

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
 * `EXISTS` rather than the scalar `valueSubquery` because this is the one
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
  properties: DatabasePropertyMap,
): Prisma.Sql {
  const property = resolveProperty(condition.propertyId, properties);
  const valueRef = isComputedColumn(property.type)
    ? computedValueRef(property.type)
    : valueSubquery(property.id, columnForType(property.type));
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
  properties: DatabasePropertyMap,
): Prisma.Sql {
  if (group.conditions.length === 0) return Prisma.sql`TRUE`;

  const combinator = group.combinator === 'or' ? ' OR ' : ' AND ';
  const parts = group.conditions.map((entry) =>
    'combinator' in entry
      ? Prisma.sql`(${compileFilterGroup(entry, properties)})`
      : compileCondition(entry, properties),
  );
  return Prisma.join(parts, combinator);
}

export function compileSorts(
  sorts: readonly DatabaseSort[],
  properties: DatabasePropertyMap,
): Prisma.Sql {
  if (sorts.length === 0) return Prisma.sql`document."orderKey" ASC`;

  const parts = sorts.map((sort) => {
    const property = resolveProperty(sort.propertyId, properties);
    const valueRef = isComputedColumn(property.type)
      ? computedValueRef(property.type)
      : valueSubquery(property.id, columnForType(property.type));
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
  properties: DatabasePropertyMap;
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
  const filterSql = compileFilterGroup(input.filters, input.properties);
  const orderSql = compileSorts(input.sorts, input.properties);

  return prisma.$queryRaw<DatabaseQueryRowRecord[]>(Prisma.sql`
    SELECT
      document.id, document."workspaceId", document."parentId", document."type"::text AS "type",
      document.title, document.icon, document."iconColor", document."layout"::text AS "layout",
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
