import {
  analyzeFormula,
  type DatabasePropertyType,
  type DatabaseRollupAggregate,
  type DatabaseRollupPropertyConfig,
  FormulaError,
  type FormulaNode,
  type FormulaPropertyResolver,
  type FormulaValueType,
  parseFormula,
  parseFormulaConfig,
  parseRelationConfig,
  parseRollupConfig,
  rollupResultType,
} from '@exocortex/contracts';

import { Prisma, type PrismaClient } from './client';

/**
 * RELATION, ROLLUP and FORMULA in SQL (issue #76, ADR-041).
 *
 * A rollup and a formula are computed by the database on every read. That is
 * the point: a column you can filter and sort by has to exist inside the query
 * that reads the rows, and a column computed afterwards in TypeScript could
 * only ever be displayed. It also keeps the promise that a derived value is
 * never a second canonical state -- there is nothing to invalidate, because
 * nothing is stored.
 *
 * Threat model is the one `database-query.ts` states: no identifier here comes
 * from a request. Property ids arrive as bind parameters, column names come
 * from `columnForType` (a closed switch over the enum), and table aliases are
 * literals in this file. The one recursion -- a formula reading another
 * formula -- carries a `seen` set, so a cycle is a validation error rather
 * than a stack overflow.
 */

export interface DatabasePropertyRef {
  id: string;
  type: DatabasePropertyType;
  /**
   * Type-specific configuration bag. Optional because the filter and sort
   * compiler never needs it; the row serializer does, to know whether a DATE
   * property is a span, and every derived property carries its whole meaning
   * in here.
   */
  config?: Record<string, unknown> | null;
  /** The collection this property belongs to. Set for every property a derived column can reach. */
  documentId?: string;
  /** Display name, which is how `prop("…")` finds it. */
  name?: string;
}

export type DatabasePropertyMap = ReadonlyMap<string, DatabasePropertyRef>;

export function buildPropertyMap(properties: readonly DatabasePropertyRef[]): DatabasePropertyMap {
  return new Map(properties.map((property) => [property.id, property]));
}

/**
 * Every property a derived column of one database may reach: its own
 * collection's, plus those of the collections its relations point at.
 * Assembled by the caller from rows it already loaded and authorized, which is
 * what keeps a `propertyId` from a request out of this.
 */
export interface DerivedSchema {
  byId: DatabasePropertyMap;
  /** `${collectionId}\u0000${lowercased name}` -> property id. */
  byName: ReadonlyMap<string, string>;
}

function nameKey(collectionId: string, name: string): string {
  return `${collectionId}\u0000${name.trim().toLowerCase()}`;
}

export function buildDerivedSchema(properties: readonly DatabasePropertyRef[]): DerivedSchema {
  const byName = new Map<string, string>();
  for (const property of properties) {
    if (property.documentId === undefined || property.name === undefined) continue;
    byName.set(nameKey(property.documentId, property.name), property.id);
  }
  return { byId: buildPropertyMap(properties), byName };
}

/**
 * What one compilation of a database query may look at.
 *
 * `properties` is the collection being queried, and is the only set a filter
 * or a sort may name a property from -- that is the check that keeps a
 * `propertyId` from another workspace out. `schema` is wider on purpose: a
 * rollup reads a column of the database its relation points at, so compiling
 * one needs that database's properties too. They are separate fields rather
 * than one map because widening the first would let a request reach the second.
 */
export interface DatabaseQueryScope {
  properties: DatabasePropertyMap;
  schema: DerivedSchema;
}

/**
 * A schema change that has not happened yet.
 *
 * Validating a change means asking "would the database still compute
 * afterwards?", which means the change has to be visible before it is written.
 * A create passes `upserts` with a placeholder id, an update passes the changed
 * property, and a delete passes `omit`.
 */
export interface PendingSchemaChange {
  upserts?: readonly DatabasePropertyRef[];
  omit?: string;
}

const DERIVED_PROPERTY_SELECT = {
  id: true,
  documentId: true,
  type: true,
  name: true,
  config: true,
} as const;

function toPropertyRef(row: {
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

function applyPending(
  properties: readonly DatabasePropertyRef[],
  pending: PendingSchemaChange,
): DatabasePropertyRef[] {
  const replaced = new Set((pending.upserts ?? []).map((property) => property.id));
  const kept = properties.filter(
    (property) => property.id !== pending.omit && !replaced.has(property.id),
  );
  return [...kept, ...(pending.upserts ?? [])];
}

/**
 * Everything one database's derived columns may look at: its own properties,
 * plus the properties of every database its relations point at.
 *
 * One hop, never more, because a rollup may not aggregate over another derived
 * column (`assertRollupTargetIsUsable`). Without that rule this load would
 * follow a chain of unknown length, and every hop would be another workspace
 * boundary to check.
 *
 * It reads the schema, never a row, and it decides nothing about access -- the
 * caller has already answered whether this database may be read. That is what
 * lets the API and the worker share it.
 */
export async function loadDatabaseScope(
  prisma: PrismaClient,
  collectionDocumentId: string,
  pending: PendingSchemaChange = {},
): Promise<DatabaseQueryScope> {
  const ownRows = await prisma.databaseProperty.findMany({
    where: { documentId: collectionDocumentId },
    select: DERIVED_PROPERTY_SELECT,
  });
  const own = applyPending(ownRows.map(toPropertyRef), pending);

  const targetIds = new Set<string>();
  for (const property of own) {
    if (property.type !== 'RELATION') continue;
    const config = parseRelationConfig(property.config);
    if (config !== null && config.targetCollectionId !== collectionDocumentId) {
      targetIds.add(config.targetCollectionId);
    }
  }

  const foreign =
    targetIds.size === 0
      ? []
      : (
          await prisma.databaseProperty.findMany({
            where: { documentId: { in: [...targetIds] } },
            select: DERIVED_PROPERTY_SELECT,
          })
        ).map(toPropertyRef);

  return {
    properties: buildPropertyMap(own),
    schema: buildDerivedSchema([...own, ...foreign]),
  };
}

/** The derived properties of the queried collection, in the order they were loaded. */
export function derivedPropertiesOf(scope: DatabaseQueryScope): DatabasePropertyRef[] {
  return [...scope.properties.values()].filter((property) => isDerivedColumn(property.type));
}

export type ValueColumn = 'textValue' | 'numberValue' | 'dateValue' | 'boolValue' | 'jsonValue';

/**
 * Code-chosen, never request-chosen. This is the one function allowed to
 * produce the string handed to `Prisma.raw` below.
 */
export function columnForType(type: DatabasePropertyType): ValueColumn {
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
    case 'RELATION':
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
    case 'ROLLUP':
    case 'FORMULA':
      throw new Error(`${type} has no document_property_value column`);
  }
}

const COMPUTED_COLUMN: Record<string, string> = {
  CREATED_TIME: 'createdAt',
  UPDATED_TIME: 'updatedAt',
  CREATED_BY: 'createdById',
  UPDATED_BY: 'updatedById',
};

export function isComputedColumn(type: DatabasePropertyType): boolean {
  return COMPUTED_COLUMN[type] !== undefined;
}

export function isDerivedColumn(type: DatabasePropertyType): boolean {
  return type === 'ROLLUP' || type === 'FORMULA';
}

/**
 * Every derived expression is correlated to the row of the outer query. There
 * is no second row to compute one for, because a rollup may not aggregate over
 * another derived column -- which is also what bounds how much schema the
 * caller has to load: its own collection plus one hop.
 */
const ROW_TABLE = Prisma.sql`document`;
const ROW_ID = Prisma.sql`document.id`;

/** One correlated subquery: the stored value of `propertyId` for the current row. */
export function storedValueExpression(propertyId: string, column: ValueColumn): Prisma.Sql {
  return Prisma.sql`(
    SELECT dpv.${Prisma.raw(`"${column}"`)}
    FROM "document_property_value" AS dpv
    WHERE dpv."documentId" = ${ROW_ID} AND dpv."propertyId" = ${propertyId}
  )`;
}

function computedValueExpression(type: DatabasePropertyType, rowTable: Prisma.Sql): Prisma.Sql {
  const column = COMPUTED_COLUMN[type];
  if (column === undefined) throw new Error(`${type} is not a computed property type`);
  return Prisma.sql`${rowTable}.${Prisma.raw(`"${column}"`)}`;
}

// ---------------------------------------------------------------------------
// RELATION
// ---------------------------------------------------------------------------

/**
 * The ids a relation points at, as a jsonb array, for the row being computed.
 *
 * `jsonb_typeof` rather than a bare `COALESCE`: a value that was cleared is
 * stored as the jsonb scalar `null` (Prisma's `JsonNull`), and
 * `jsonb_array_elements_text` raises on anything that is not an array. An
 * empty array is the right reading of "no links", so the guard is here and not
 * at every call site.
 */
function relationIdsExpression(relationPropertyId: string): Prisma.Sql {
  return Prisma.sql`COALESCE((
    SELECT CASE WHEN jsonb_typeof(dpv."jsonValue") = 'array' THEN dpv."jsonValue" ELSE '[]'::jsonb END
    FROM "document_property_value" AS dpv
    WHERE dpv."documentId" = ${ROW_ID} AND dpv."propertyId" = ${relationPropertyId}
  ), '[]'::jsonb)`;
}

// ---------------------------------------------------------------------------
// ROLLUP
// ---------------------------------------------------------------------------

/** A derived property whose configuration does not describe a column. */
export class DerivedPropertyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerivedPropertyError';
  }
}

const NUMERIC_AGGREGATES = new Set<DatabaseRollupAggregate>(['sum', 'average', 'min', 'max']);
const DATE_AGGREGATES = new Set<DatabaseRollupAggregate>(['earliest', 'latest']);

/**
 * Which target columns an aggregate may read.
 *
 * A rollup deliberately does not aggregate over another rollup or formula.
 * That is the rule that bounds this whole feature: without it, computing one
 * column would need the schema of a chain of databases of unknown length, and
 * every one of those hops would be a fresh authorization question. One hop is
 * enough for "how many open tasks does this project have", which is what a
 * rollup is for.
 */
export function assertRollupTargetIsUsable(
  aggregate: DatabaseRollupAggregate,
  target: DatabasePropertyRef | undefined,
): void {
  if (aggregate === 'count') return;
  if (target === undefined) {
    throw new DerivedPropertyError(`Das Rollup "${aggregate}" braucht eine Zielspalte`);
  }
  if (isDerivedColumn(target.type) || target.type === 'RELATION') {
    throw new DerivedPropertyError(
      `Ein Rollup kann nicht über eine Spalte vom Typ ${target.type} rechnen; wähle eine einfache Spalte`,
    );
  }
  if (NUMERIC_AGGREGATES.has(aggregate) && target.type !== 'NUMBER') {
    throw new DerivedPropertyError(`Das Rollup "${aggregate}" erwartet eine Zahlenspalte`);
  }
  if (
    DATE_AGGREGATES.has(aggregate) &&
    target.type !== 'DATE' &&
    target.type !== 'CREATED_TIME' &&
    target.type !== 'UPDATED_TIME'
  ) {
    throw new DerivedPropertyError(`Das Rollup "${aggregate}" erwartet eine Datumsspalte`);
  }
}

const LINK_TABLE = Prisma.sql`link_document`;
const LINK_ID = Prisma.sql`link_document.id`;

function rollupAggregate(aggregate: DatabaseRollupAggregate, target: Prisma.Sql): Prisma.Sql {
  switch (aggregate) {
    case 'count_unique':
      return Prisma.sql`COUNT(DISTINCT ${target})`;
    case 'count_not_empty':
      return Prisma.sql`COUNT(${target})`;
    // An empty sum is 0, which is what a column of numbers reads as. Every
    // other aggregate over no rows stays empty, because "no minimum" is not 0.
    case 'sum':
      return Prisma.sql`COALESCE(SUM(${target}), 0)`;
    case 'average':
      return Prisma.sql`AVG(${target})`;
    case 'min':
    case 'earliest':
      return Prisma.sql`MIN(${target})`;
    case 'max':
    case 'latest':
      return Prisma.sql`MAX(${target})`;
    case 'count':
      throw new Error('count is compiled without a target column');
  }
}

function rollupParts(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
): { config: DatabaseRollupPropertyConfig; relation: DatabasePropertyRef } {
  const label = property.name ?? property.id;
  const config = parseRollupConfig(property.config);
  if (config === null) {
    throw new DerivedPropertyError(`Die Rollup-Spalte "${label}" ist unvollständig`);
  }
  const relation = schema.byId.get(config.relationPropertyId);
  if (relation === undefined || relation.type !== 'RELATION') {
    throw new DerivedPropertyError(`Die Rollup-Spalte "${label}" zeigt auf keine Verknüpfung`);
  }
  return { config, relation };
}

function compileRollup(property: DatabasePropertyRef, schema: DerivedSchema): Prisma.Sql {
  const { config, relation } = rollupParts(property, schema);
  const ids = relationIdsExpression(relation.id);
  if (config.aggregate === 'count') {
    return Prisma.sql`COALESCE(jsonb_array_length(${ids}), 0)`;
  }

  const target =
    config.targetPropertyId === null ? undefined : schema.byId.get(config.targetPropertyId);
  assertRollupTargetIsUsable(config.aggregate, target);
  if (target === undefined) throw new DerivedPropertyError('Rollup ohne Zielspalte');

  const targetValue = isComputedColumn(target.type)
    ? computedValueExpression(target.type, LINK_TABLE)
    : Prisma.sql`(
        SELECT dpv.${Prisma.raw(`"${columnForType(target.type)}"`)}
        FROM "document_property_value" AS dpv
        WHERE dpv."documentId" = ${LINK_ID} AND dpv."propertyId" = ${target.id}
      )`;

  // An archived linked row drops out here rather than out of the relation
  // value: the link itself survives the trash, so restoring the row brings its
  // contribution back without anyone having to relink it.
  return Prisma.sql`(
    SELECT ${rollupAggregate(config.aggregate, targetValue)}
    FROM jsonb_array_elements_text(${ids}) AS link_id(id)
    JOIN "document" AS link_document
      ON link_document.id = link_id.id AND link_document."archivedAt" IS NULL
  )`;
}

// ---------------------------------------------------------------------------
// FORMULA
// ---------------------------------------------------------------------------

/** The property a `prop("…")` reference means: by id first, by name second. */
function resolveRef(
  ref: string,
  schema: DerivedSchema,
  collectionId: string,
): DatabasePropertyRef | undefined {
  const byId = schema.byId.get(ref);
  if (byId !== undefined) return byId;
  const id = schema.byName.get(nameKey(collectionId, ref));
  return id === undefined ? undefined : schema.byId.get(id);
}

/**
 * The value type a property contributes to a formula.
 *
 * `seen` is what keeps a formula that reads a formula from being a way to hang
 * the API: two columns defined in terms of each other type-check forever
 * otherwise, and a cycle is a thing a person can build by editing one of two
 * perfectly valid formulas.
 */
export function formulaTypeOf(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
  seen: ReadonlySet<string> = new Set(),
): FormulaValueType {
  const label = property.name ?? property.id;
  switch (property.type) {
    case 'NUMBER':
      return 'number';
    case 'CHECKBOX':
      return 'boolean';
    case 'DATE':
    case 'CREATED_TIME':
    case 'UPDATED_TIME':
      return 'date';
    case 'TEXT':
    case 'SELECT':
    case 'URL':
    case 'EMAIL':
    case 'PHONE':
    case 'CREATED_BY':
    case 'UPDATED_BY':
      return 'text';
    case 'ROLLUP':
      return rollupResultType(rollupParts(property, schema).config.aggregate);
    case 'FORMULA':
      return analyzeFormula(
        formulaNodeOf(property),
        formulaResolver(property, schema, guard(property, seen)),
      );
    default:
      throw new FormulaError(
        `Die Spalte "${label}" hat den Typ ${property.type} und lässt sich in einer Formel nicht verwenden`,
      );
  }
}

function guard(property: DatabasePropertyRef, seen: ReadonlySet<string>): ReadonlySet<string> {
  if (seen.has(property.id)) {
    throw new FormulaError(
      `Die Spalte "${property.name ?? property.id}" hängt im Kreis von sich selbst ab`,
    );
  }
  if (seen.size >= MAX_DERIVED_DEPTH) {
    throw new FormulaError('Die berechneten Spalten sind zu tief verschachtelt');
  }
  return new Set([...seen, property.id]);
}

function formulaNodeOf(property: DatabasePropertyRef): FormulaNode {
  const config = parseFormulaConfig(property.config);
  if (config === null) {
    throw new FormulaError(`Die Formelspalte "${property.name ?? property.id}" ist leer`);
  }
  return parseFormula(config.expression);
}

function formulaResolver(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
  seen: ReadonlySet<string>,
): FormulaPropertyResolver {
  const collectionId = property.documentId ?? '';
  return (ref) => {
    const referenced = resolveRef(ref, schema, collectionId);
    return referenced === undefined ? null : formulaTypeOf(referenced, schema, seen);
  };
}

const CASTS: Record<FormulaValueType, string> = {
  number: 'numeric',
  text: 'text',
  boolean: 'boolean',
  date: 'timestamptz',
};

interface FormulaContext {
  schema: DerivedSchema;
  /** The collection whose `prop("…")` names are in scope. */
  collectionId: string;
  /** Derived property ids currently being compiled, innermost last. */
  seen: ReadonlySet<string>;
}

function compileFormulaNode(node: FormulaNode, context: FormulaContext): Prisma.Sql {
  switch (node.kind) {
    case 'number':
      return Prisma.sql`(${node.value})::numeric`;
    case 'text':
      return Prisma.sql`(${node.value})::text`;
    case 'boolean':
      return Prisma.sql`(${node.value})::boolean`;
    case 'property':
      return compilePropertyRef(node.ref, context);
    case 'negate':
      return Prisma.sql`(-(${compileFormulaNode(node.operand, context)}))`;
    case 'binary':
      return compileBinary(node, context);
    case 'call':
      return compileCall(node.name, node.args, context);
  }
}

function compilePropertyRef(ref: string, context: FormulaContext): Prisma.Sql {
  const property = resolveRef(ref, context.schema, context.collectionId);
  if (property === undefined) throw new FormulaError(`Unbekannte Spalte: ${ref}`);
  if (isComputedColumn(property.type)) {
    return Prisma.sql`(${computedValueExpression(property.type, ROW_TABLE)})`;
  }
  if (isDerivedColumn(property.type)) {
    return compileDerived(property, context.schema, context.seen);
  }
  // An unchecked box is false, not unknown: `if(prop("Erledigt"); …)` has to
  // take the else branch for a row nobody has ticked yet, and a NULL there
  // would make the whole CASE unknown instead.
  if (property.type === 'CHECKBOX') {
    return Prisma.sql`COALESCE(${storedValueExpression(property.id, 'boolValue')}, false)`;
  }
  return Prisma.sql`(${storedValueExpression(property.id, columnForType(property.type))})`;
}

const SQL_BINARY: Record<string, string> = {
  '+': '+',
  '-': '-',
  '*': '*',
  '==': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  and: 'AND',
  or: 'OR',
};

function compileBinary(
  node: Extract<FormulaNode, { kind: 'binary' }>,
  context: FormulaContext,
): Prisma.Sql {
  const left = compileFormulaNode(node.left, context);
  const right = compileFormulaNode(node.right, context);
  // Division is the only operator that can raise at runtime, and a formula
  // that raises would take down the whole query, not just its own column. An
  // empty cell is the honest answer to "divided by nothing".
  if (node.operator === '/') return Prisma.sql`(${left} / NULLIF(${right}, 0))`;
  if (node.operator === '%') return Prisma.sql`(${left} % NULLIF(${right}, 0))`;
  const operator = SQL_BINARY[node.operator];
  if (operator === undefined) throw new FormulaError(`Unbekannter Operator ${node.operator}`);
  return Prisma.sql`(${left} ${Prisma.raw(operator)} ${right})`;
}

/* eslint-disable-next-line complexity -- one arm per entry of the closed FORMULA_FUNCTIONS table */
function compileCall(name: string, args: FormulaNode[], context: FormulaContext): Prisma.Sql {
  const compiled = args.map((argument) => compileFormulaNode(argument, context));
  const [first, second, third] = compiled;
  const list = Prisma.join(compiled, ', ');
  switch (name) {
    case 'if':
      return Prisma.sql`(CASE WHEN ${first} THEN ${second} ELSE ${third} END)`;
    case 'not':
      return Prisma.sql`(NOT ${first})`;
    case 'and':
      return Prisma.sql`(${first} AND ${second})`;
    case 'or':
      return Prisma.sql`(${first} OR ${second})`;
    case 'empty':
      return Prisma.sql`(${first} IS NULL)`;
    case 'format':
      return Prisma.sql`(${first})::text`;
    case 'concat':
      return Prisma.sql`concat(${list})`;
    case 'length':
      return Prisma.sql`length(${first})::numeric`;
    case 'upper':
      return Prisma.sql`upper(${first})`;
    case 'lower':
      return Prisma.sql`lower(${first})`;
    case 'contains':
      return Prisma.sql`(strpos(${first}, ${second}) > 0)`;
    case 'abs':
      return Prisma.sql`abs(${first})`;
    case 'floor':
      return Prisma.sql`floor(${first})`;
    case 'ceil':
      return Prisma.sql`ceil(${first})`;
    case 'round':
      return second === undefined
        ? Prisma.sql`round(${first})`
        : Prisma.sql`round(${first}, (${second})::int)`;
    case 'min':
      return Prisma.sql`LEAST(${list})`;
    case 'max':
      return Prisma.sql`GREATEST(${list})`;
    case 'now':
      return Prisma.sql`now()`;
    case 'dateAdd':
      return Prisma.sql`(${first} + make_interval(days => (${second})::int))`;
    case 'dateDiffDays':
      return Prisma.sql`(EXTRACT(EPOCH FROM (${second} - ${first})) / 86400)::numeric`;
    case 'year':
      return Prisma.sql`EXTRACT(YEAR FROM ${first})::numeric`;
    case 'month':
      return Prisma.sql`EXTRACT(MONTH FROM ${first})::numeric`;
    case 'day':
      return Prisma.sql`EXTRACT(DAY FROM ${first})::numeric`;
    default:
      throw new FormulaError(`Unbekannte Funktion "${name}"`);
  }
}

function compileFormula(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
  seen: ReadonlySet<string>,
): Prisma.Sql {
  const node = formulaNodeOf(property);
  const nested = guard(property, seen);
  // Types before SQL: the check is what proves the cast below is sound, and it
  // is the same call the API made before it let this config be saved.
  const type = analyzeFormula(node, formulaResolver(property, schema, nested));
  const context: FormulaContext = {
    schema,
    collectionId: property.documentId ?? '',
    seen: nested,
  };
  return Prisma.sql`(${compileFormulaNode(node, context)})::${Prisma.raw(CASTS[type])}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** How far a formula may reach through other formulas before it is called a mess. */
export const MAX_DERIVED_DEPTH = 8;

/**
 * The SQL scalar expression for one derived property, correlated to the row of
 * the outer query. The same string is used three times: in the SELECT list
 * that returns the value, in a WHERE condition that filters on it, and in the
 * ORDER BY that sorts by it. That is the whole reason a formula is compiled
 * rather than evaluated -- one definition, three jobs.
 */
export function compileDerived(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
  seen: ReadonlySet<string> = new Set(),
): Prisma.Sql {
  if (property.type === 'ROLLUP') {
    guard(property, seen);
    return compileRollup(property, schema);
  }
  if (property.type === 'FORMULA') return compileFormula(property, schema, seen);
  throw new Error(`${property.type} is not a derived property type`);
}

/** What a derived property answers with, so the caller knows how to serialize it. */
export function derivedResultType(
  property: DatabasePropertyRef,
  schema: DerivedSchema,
): FormulaValueType {
  return formulaTypeOf(property, schema);
}
