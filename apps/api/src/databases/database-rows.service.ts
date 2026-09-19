import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  ARRAY_VALUED_PROPERTY_TYPES,
  type CreateDatabaseRowRequest,
  databaseDateRangeValueSchema,
  type DatabaseFilterGroup,
  databaseFilterGroupSchema,
  type DatabasePropertyType,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  type DatabaseSort,
  databaseSortSchema,
  EMPTY_DATABASE_FILTER_GROUP,
  type FormulaValueType,
  parseDatePropertyConfig,
  type QueryDatabaseRowsRequest,
  type QueryDatabaseRowsResponse,
  type UpdateDatabaseRowValuesRequest,
} from '@exocortex/contracts';
import {
  type DatabasePropertyRef,
  type DatabaseQueryRowRecord,
  type DatabaseQueryScope,
  derivedPropertiesOf,
  DerivedPropertyError,
  formulaTypeOf,
  InvalidDatabaseFilterError,
  isDerivedColumn,
  loadDatabaseScope,
  Prisma,
  type PrismaClient,
  queryDatabaseRows,
  queryDerivedValues,
  UnknownDatabasePropertyError,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { DocumentsService, toSummary } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { normalizeRelationValue } from './derived-properties';

const sortsArraySchema = z.array(databaseSortSchema);

const COMPUTED_TYPES = new Set<DatabasePropertyType>([
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
]);
const ARRAY_TYPES = new Set<DatabasePropertyType>(ARRAY_VALUED_PROPERTY_TYPES);

function computedValue(type: DatabasePropertyType, row: DatabaseQueryRowRecord): string {
  switch (type) {
    case 'CREATED_TIME':
      return row.createdAt.toISOString();
    case 'UPDATED_TIME':
      return row.updatedAt.toISOString();
    case 'CREATED_BY':
      return row.createdById;
    case 'UPDATED_BY':
      return row.updatedById;
    default:
      throw new Error(`${type} is not a computed property type`);
  }
}

interface StoredValueRow {
  propertyId: string;
  textValue: string | null;
  numberValue: unknown;
  boolValue: boolean | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
  dateAllDay: boolean | null;
  jsonValue: unknown;
}

/**
 * Response shape of a DATE value is decided by the property, not by what
 * happens to be stored: `isRange: false` returns the bare ISO string every
 * client has always read, `isRange: true` returns the span object. Deriving it
 * from "is `dateEndValue` set?" instead would make the same property answer in
 * two different shapes depending on the row, which no client can type.
 */
function storedToDateResponseValue(
  property: DatabasePropertyRef,
  stored: StoredValueRow,
): DatabaseRowPropertyValue['value'] {
  if (stored.dateValue === null) return null;
  if (!parseDatePropertyConfig(property.config).isRange) return stored.dateValue.toISOString();
  return {
    start: stored.dateValue.toISOString(),
    end: stored.dateEndValue === null ? null : stored.dateEndValue.toISOString(),
    allDay: stored.dateAllDay ?? false,
  };
}

/**
 * A derived value on its way out.
 *
 * PostgreSQL answers `numeric` as a string or a Decimal depending on the
 * driver, and the wire contract says number, so the conversion happens here
 * once rather than in every client. An empty aggregate stays `null`: "no
 * linked rows had a date" is not a date.
 */
function derivedToResponseValue(
  type: FormulaValueType,
  raw: unknown,
): DatabaseRowPropertyValue['value'] {
  if (raw === null || raw === undefined) return null;
  if (type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === 'boolean') return Boolean(raw);
  if (type === 'date') return raw instanceof Date ? raw.toISOString() : String(raw);
  return String(raw);
}

function storedToResponseValue(
  property: DatabasePropertyRef,
  stored: StoredValueRow | undefined,
): DatabaseRowPropertyValue['value'] {
  if (stored === undefined) return null;
  if (property.type === 'NUMBER')
    return stored.numberValue === null ? null : Number(stored.numberValue);
  if (property.type === 'CHECKBOX') return stored.boolValue;
  if (property.type === 'DATE') return storedToDateResponseValue(property, stored);
  if (ARRAY_TYPES.has(property.type)) return (stored.jsonValue as string[] | null) ?? null;
  return stored.textValue;
}

interface ColumnData {
  textValue: string | null;
  numberValue: number | null;
  boolValue: boolean | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
  dateAllDay: boolean | null;
  // Prisma's Json column needs the `JsonNull` sentinel for an explicit null,
  // not the plain JS value: a bare `null` there means "leave column unset".
  jsonValue: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

function parseIsoOrThrow(propertyId: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation(`Property ${propertyId} received an invalid date`);
  }
  return date;
}

/**
 * A DATE write accepts the bare ISO string in both modes, so every existing
 * writer (the MCP catalogue, Hermes, the morning briefing) keeps working; the
 * span object is accepted only where the property actually is a span, because
 * silently dropping an `end` on a non-range property would look like a
 * successful write of data that is not there afterwards.
 */
function toDateColumnData(
  property: DatabasePropertyRef,
  value: DatabaseRowPropertyValue['value'],
  empty: ColumnData,
): ColumnData {
  if (typeof value === 'string') {
    return { ...empty, dateValue: parseIsoOrThrow(property.id, value) };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.validation(`Property ${property.id} expects an ISO date string or a date span`);
  }
  if (!parseDatePropertyConfig(property.config).isRange) {
    throw AppError.validation(
      `Property ${property.id} is not a date span; pass an ISO date string`,
    );
  }
  const span = databaseDateRangeValueSchema.safeParse(value);
  if (!span.success) {
    throw AppError.validation(`Property ${property.id} expects { start, end, allDay }`);
  }
  const start = parseIsoOrThrow(property.id, span.data.start);
  const end = span.data.end === null ? null : parseIsoOrThrow(property.id, span.data.end);
  if (end !== null && end < start) {
    throw AppError.validation(`Property ${property.id} received a span that ends before it starts`);
  }
  return { ...empty, dateValue: start, dateEndValue: end, dateAllDay: span.data.allDay };
}

/** Converts one incoming `{propertyId, value}` write into the correct typed column. */
function toColumnData(
  property: DatabasePropertyRef,
  value: DatabaseRowPropertyValue['value'],
): ColumnData {
  const empty: ColumnData = {
    textValue: null,
    numberValue: null,
    boolValue: null,
    dateValue: null,
    dateEndValue: null,
    dateAllDay: null,
    jsonValue: Prisma.JsonNull,
  };
  if (value === null) return empty;

  if (property.type === 'NUMBER') {
    if (typeof value !== 'number')
      throw AppError.validation(`Property ${property.id} expects a number`);
    return { ...empty, numberValue: value };
  }
  if (property.type === 'CHECKBOX') {
    if (typeof value !== 'boolean')
      throw AppError.validation(`Property ${property.id} expects a boolean`);
    return { ...empty, boolValue: value };
  }
  if (property.type === 'DATE') {
    return toDateColumnData(property, value, empty);
  }
  if (ARRAY_TYPES.has(property.type)) {
    if (!Array.isArray(value))
      throw AppError.validation(`Property ${property.id} expects an array of ids`);
    return { ...empty, jsonValue: value };
  }
  if (typeof value !== 'string')
    throw AppError.validation(`Property ${property.id} expects a string`);
  return { ...empty, textValue: value };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Rows of a database. A row is an ordinary `Document` (`type: 'PAGE'`) child
 * of a `COLLECTION` document — creation delegates entirely to
 * `DocumentsService.create` so a row gets the same Yjs content, outbox event,
 * realtime emit and search indexing as any other page (ADR-011). This
 * service adds only the typed property values on top.
 */
@Injectable()
export class DatabaseRowsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly documents: DocumentsService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async query(input: {
    collectionDocumentId: string;
    userId: string;
    request: QueryDatabaseRowsRequest;
  }): Promise<QueryDatabaseRowsResponse> {
    const context = await this.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const scope = await loadDatabaseScope(this.prisma, input.collectionDocumentId);

    const { filters, sorts } = await this.resolveFiltersAndSorts(
      input.collectionDocumentId,
      input.request,
    );
    const offset = decodeCursor(input.request.cursor);
    const limit = input.request.limit;

    let rows: DatabaseQueryRowRecord[];
    try {
      rows = await queryDatabaseRows(this.prisma, {
        workspaceId: context.workspaceId,
        collectionDocumentId: input.collectionDocumentId,
        scope,
        filters,
        sorts,
        limit,
        offset,
      });
    } catch (error) {
      throw this.toQueryError(error);
    }

    const rowIds = rows.map((row) => row.id);
    const [values, derived] = await Promise.all([
      this.prisma.documentPropertyValue.findMany({ where: { documentId: { in: rowIds } } }),
      this.readDerivedValues(rowIds, scope),
    ]);
    const valuesByRow = new Map<string, StoredValueRow[]>();
    for (const value of values) {
      const list = valuesByRow.get(value.documentId);
      if (list === undefined) valuesByRow.set(value.documentId, [value]);
      else list.push(value);
    }

    const propertyList = [...scope.properties.values()];
    const result: DatabaseRow[] = rows.map((row) => ({
      document: toSummary(row),
      values: propertyList.map((property) =>
        this.toValue(property, scope, {
          row,
          stored: valuesByRow.get(row.id)?.find((entry) => entry.propertyId === property.id),
          derived: derived.get(row.id)?.get(property.id),
        }),
      ),
    }));

    return {
      rows: result,
      nextCursor: rows.length === limit ? encodeCursor(offset + limit) : null,
    };
  }

  /**
   * One `{propertyId, value}` pair, whichever of the three kinds of column it
   * is: computed from the row document, stored in `document_property_value`,
   * or derived by the query engine from other rows.
   */
  private toValue(
    property: DatabasePropertyRef,
    scope: DatabaseQueryScope,
    sources: {
      row: DatabaseQueryRowRecord;
      stored: StoredValueRow | undefined;
      derived: unknown;
    },
  ): DatabaseRowPropertyValue {
    if (COMPUTED_TYPES.has(property.type)) {
      return { propertyId: property.id, value: computedValue(property.type, sources.row) };
    }
    if (isDerivedColumn(property.type)) {
      return {
        propertyId: property.id,
        value: derivedToResponseValue(formulaTypeOf(property, scope.schema), sources.derived),
      };
    }
    return { propertyId: property.id, value: storedToResponseValue(property, sources.stored) };
  }

  /**
   * The ROLLUP and FORMULA values of a page of rows, or empty values when the
   * database cannot compute them.
   *
   * A broken configuration is refused when it is written, so reaching this
   * catch means something changed underneath one -- and a table that shows
   * every other column is a far better answer to that than a 500 on the whole
   * database.
   */
  private async readDerivedValues(
    rowIds: readonly string[],
    scope: DatabaseQueryScope,
  ): Promise<Map<string, Map<string, unknown>>> {
    const derived = derivedPropertiesOf(scope);
    if (derived.length === 0 || rowIds.length === 0) return new Map();
    try {
      return await queryDerivedValues(this.prisma, { documentIds: rowIds, derived, scope });
    } catch (error) {
      if (error instanceof DerivedPropertyError) return new Map();
      throw error;
    }
  }

  private toQueryError(error: unknown): unknown {
    if (
      error instanceof UnknownDatabasePropertyError ||
      error instanceof InvalidDatabaseFilterError
    ) {
      return AppError.validation(error.message);
    }
    if (error instanceof DerivedPropertyError) {
      return new AppError('database_property_config_invalid', error.message);
    }
    return error;
  }

  async create(input: {
    collectionDocumentId: string;
    userId: string;
    request: CreateDatabaseRowRequest;
    correlationId: string;
  }): Promise<DatabaseRow> {
    const context = await this.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canCreateDocument(context.role));

    const row = await this.documents.create({
      workspaceId: context.workspaceId,
      userId: input.userId,
      request: { title: input.request.title, type: 'PAGE', parentId: input.collectionDocumentId },
      correlationId: input.correlationId,
    });

    if (input.request.values.length > 0) {
      // No realtime emit and no second event beside it: `documents.create`
      // already announced the row, and the values are part of the same act of
      // creating it. What the outbox row here buys is that a rule watching for
      // filled-in values sees a row created with them, exactly as it sees one
      // filled in afterwards.
      await this.writeValues({
        collectionDocumentId: input.collectionDocumentId,
        rowId: row.id,
        values: input.request.values,
        workspaceId: context.workspaceId,
        correlationId: input.correlationId,
      });
    }

    return this.toRowResponse(input.collectionDocumentId, row.id);
  }

  /**
   * Answers "is this document a database row, and if so what are its values?"
   * for the context panel's properties tab (issue #17) and the `exo_database_row_get`
   * MCP tool — both need a row's values by the row's own id, without already
   * knowing (or querying for) its collection.
   *
   * Returns `null`, not a 404, when the document is not a `PAGE` whose parent
   * is a `COLLECTION` (ADR-011): a plain page, a database itself and a
   * top-level document are all simply "not a row", which is a normal answer
   * here, not an error.
   */
  async getForDocument(documentId: string, userId: string): Promise<DatabaseRow | null> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const collectionDocumentId = context.document.parentId;
    if (collectionDocumentId === null) return null;

    const parent = await this.prisma.document.findUnique({
      where: { id: collectionDocumentId },
      select: { type: true },
    });
    if (parent === null || parent.type !== 'COLLECTION') return null;

    return this.toRowResponse(collectionDocumentId, documentId);
  }

  async updateValues(input: {
    rowId: string;
    userId: string;
    request: UpdateDatabaseRowValuesRequest;
    correlationId: string;
  }): Promise<DatabaseRow> {
    const rowContext = await this.access.requireDocumentContext(input.rowId, input.userId);
    assertPolicy(canEditDocument(rowContext.role, rowContext.document));
    const collectionDocumentId = rowContext.document.parentId;
    if (collectionDocumentId === null) {
      throw AppError.validation('Document is not a database row');
    }

    await this.writeValues({
      collectionDocumentId,
      rowId: input.rowId,
      values: input.request.values,
      workspaceId: rowContext.workspaceId,
      correlationId: input.correlationId,
    });

    // Best-effort and after the commit, like every realtime emit here: a client
    // that misses it refetches on its own schedule, and the reliable half of the
    // same news is the outbox row written inside the transaction (ADR-010).
    await this.realtime.emit('database.row.updated', rowContext.workspaceId, input.correlationId, {
      documentId: collectionDocumentId,
      rowId: input.rowId,
    });

    return this.toRowResponse(collectionDocumentId, input.rowId);
  }

  /**
   * Writes a row's property values, and records that they changed.
   *
   * An interactive transaction rather than an array of upserts, because the
   * outbox row has to be written inside the same transaction as the values it
   * describes (ADR-010). Without that event nothing downstream can react to a
   * row changing: an automation scoped to a database would only ever see rows
   * being created and renamed, never filled in, which is most of what happens
   * to a row (issue #50).
   *
   * `workspaceId` is threaded through rather than looked up here: every caller
   * has already resolved the row's access context, and a second lookup would be
   * a second chance to disagree about which workspace this is.
   */
  private async writeValues(input: {
    collectionDocumentId: string;
    rowId: string;
    values: DatabaseRowPropertyValue[];
    workspaceId: string;
    correlationId: string;
  }): Promise<void> {
    const scope = await loadDatabaseScope(this.prisma, input.collectionDocumentId);

    // Resolved before the transaction opens: a validation failure here is the
    // caller's mistake, and finding it out with a transaction held open would
    // hold a connection for the length of the check. Relations are the one kind
    // that needs the database to check them, because the ids have to be rows of
    // the linked collection -- so that lookup happens here too, not inside.
    const writes = await Promise.all(
      input.values.map(async (entry) => {
        const property = scope.properties.get(entry.propertyId);
        if (property === undefined) {
          throw AppError.validation(`Unknown property in this database: ${entry.propertyId}`);
        }
        if (COMPUTED_TYPES.has(property.type)) {
          throw AppError.validation(`${property.type} is computed and cannot be written directly`);
        }
        if (isDerivedColumn(property.type)) {
          throw AppError.validation(
            `${property.type} is computed from other rows and cannot be written`,
          );
        }
        const value =
          property.type === 'RELATION' && entry.value !== null
            ? await normalizeRelationValue({ prisma: this.prisma, property, value: entry.value })
            : entry.value;
        return { propertyId: entry.propertyId, columns: toColumnData(property, value) };
      }),
    );

    await this.prisma.$transaction(async (tx) => {
      for (const write of writes) {
        await tx.documentPropertyValue.upsert({
          where: {
            documentId_propertyId: { documentId: input.rowId, propertyId: write.propertyId },
          },
          create: { documentId: input.rowId, propertyId: write.propertyId, ...write.columns },
          update: write.columns,
        });
      }

      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'database.row.updated',
        payload: { documentId: input.collectionDocumentId, rowId: input.rowId },
        correlationId: input.correlationId,
      });
    });
  }

  private async toRowResponse(collectionDocumentId: string, rowId: string): Promise<DatabaseRow> {
    const [row, scope, values] = await Promise.all([
      this.documents.loadDocumentOrThrow(rowId),
      loadDatabaseScope(this.prisma, collectionDocumentId),
      this.prisma.documentPropertyValue.findMany({ where: { documentId: rowId } }),
    ]);
    const derived = (await this.readDerivedValues([rowId], scope)).get(rowId);

    return {
      document: toSummary(row),
      values: [...scope.properties.values()].map((property) =>
        this.toValue(property, scope, {
          row: row as unknown as DatabaseQueryRowRecord,
          stored: values.find((entry) => entry.propertyId === property.id),
          derived: derived?.get(property.id),
        }),
      ),
    };
  }

  private async requireCollection(documentId: string, userId: string) {
    const context = await this.access.requireDocumentContext(documentId, userId);
    if (context.document.type !== 'COLLECTION') {
      throw AppError.validation('Document is not a database');
    }
    return context;
  }

  private async resolveFiltersAndSorts(
    collectionDocumentId: string,
    request: QueryDatabaseRowsRequest,
  ): Promise<{ filters: DatabaseFilterGroup; sorts: DatabaseSort[] }> {
    if (request.viewId !== undefined) {
      const view = await this.prisma.databaseView.findUnique({ where: { id: request.viewId } });
      if (view === null || view.documentId !== collectionDocumentId) {
        throw AppError.notFound('Database view');
      }
      // Re-parsed rather than cast: see the comment on `toResponse` in
      // database-views.service.ts.
      const viewFilters = databaseFilterGroupSchema.parse(view.filters);
      return {
        // Inline filters narrow the view, they never replace it: the caller
        // that names a view gets the view's rows, and may ask for fewer of
        // them (a calendar asking for one week). Both groups are nested under
        // one `and` so a saved `or` group keeps its own combinator, and an
        // empty group compiles to `TRUE` rather than to nothing.
        filters:
          request.filters === undefined
            ? viewFilters
            : { combinator: 'and', conditions: [viewFilters, request.filters] },
        // Sorts are not additive: a view's order is the order, and a second
        // list appended to it would only ever break ties that the first list
        // already decided.
        sorts: sortsArraySchema.parse(view.sorts),
      };
    }
    return {
      filters: request.filters ?? EMPTY_DATABASE_FILTER_GROUP,
      sorts: request.sorts ?? [],
    };
  }
}
