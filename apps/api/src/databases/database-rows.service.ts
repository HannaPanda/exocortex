import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { assertPolicy, canCreateDocument, canEditDocument, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CreateDatabaseRowRequest,
  type DatabaseFilterGroup,
  databaseFilterGroupSchema,
  type DatabasePropertyType,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  type DatabaseSort,
  databaseSortSchema,
  EMPTY_DATABASE_FILTER_GROUP,
  type QueryDatabaseRowsRequest,
  type QueryDatabaseRowsResponse,
  type UpdateDatabaseRowValuesRequest,
} from '@exocortex/contracts';
import {
  buildPropertyMap,
  type DatabasePropertyRef,
  type DatabaseQueryRowRecord,
  Prisma,
  type PrismaClient,
  queryDatabaseRows,
  UnknownDatabasePropertyError,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { DocumentsService, toSummary } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

const sortsArraySchema = z.array(databaseSortSchema);

const COMPUTED_TYPES = new Set<DatabasePropertyType>(['CREATED_TIME', 'UPDATED_TIME', 'CREATED_BY', 'UPDATED_BY']);
const ARRAY_TYPES = new Set<DatabasePropertyType>(['MULTI_SELECT', 'PERSON', 'FILES']);

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
  jsonValue: unknown;
}

function storedToResponseValue(property: DatabasePropertyRef, stored: StoredValueRow | undefined): DatabaseRowPropertyValue['value'] {
  if (stored === undefined) return null;
  if (property.type === 'NUMBER') return stored.numberValue === null ? null : Number(stored.numberValue);
  if (property.type === 'CHECKBOX') return stored.boolValue;
  if (property.type === 'DATE') return stored.dateValue === null ? null : stored.dateValue.toISOString();
  if (ARRAY_TYPES.has(property.type)) return (stored.jsonValue as string[] | null) ?? null;
  return stored.textValue;
}

interface ColumnData {
  textValue: string | null;
  numberValue: number | null;
  boolValue: boolean | null;
  dateValue: Date | null;
  // Prisma's Json column needs the `JsonNull` sentinel for an explicit null,
  // not the plain JS value: a bare `null` there means "leave column unset".
  jsonValue: Prisma.InputJsonValue | typeof Prisma.JsonNull;
}

/** Converts one incoming `{propertyId, value}` write into the correct typed column. */
function toColumnData(property: DatabasePropertyRef, value: DatabaseRowPropertyValue['value']): ColumnData {
  const empty: ColumnData = {
    textValue: null,
    numberValue: null,
    boolValue: null,
    dateValue: null,
    jsonValue: Prisma.JsonNull,
  };
  if (value === null) return empty;

  if (property.type === 'NUMBER') {
    if (typeof value !== 'number') throw AppError.validation(`Property ${property.id} expects a number`);
    return { ...empty, numberValue: value };
  }
  if (property.type === 'CHECKBOX') {
    if (typeof value !== 'boolean') throw AppError.validation(`Property ${property.id} expects a boolean`);
    return { ...empty, boolValue: value };
  }
  if (property.type === 'DATE') {
    if (typeof value !== 'string') throw AppError.validation(`Property ${property.id} expects an ISO date string`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw AppError.validation(`Property ${property.id} received an invalid date`);
    return { ...empty, dateValue: date };
  }
  if (ARRAY_TYPES.has(property.type)) {
    if (!Array.isArray(value)) throw AppError.validation(`Property ${property.id} expects an array of ids`);
    return { ...empty, jsonValue: value };
  }
  if (typeof value !== 'string') throw AppError.validation(`Property ${property.id} expects a string`);
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
  ) {}

  async query(input: {
    collectionDocumentId: string;
    userId: string;
    request: QueryDatabaseRowsRequest;
  }): Promise<QueryDatabaseRowsResponse> {
    const context = await this.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const propertyRows = await this.prisma.databaseProperty.findMany({
      where: { documentId: input.collectionDocumentId },
      select: { id: true, type: true },
    });
    const properties = buildPropertyMap(propertyRows);

    const { filters, sorts } = await this.resolveFiltersAndSorts(input.collectionDocumentId, input.request);
    const offset = decodeCursor(input.request.cursor);
    const limit = input.request.limit;

    let rows: DatabaseQueryRowRecord[];
    try {
      rows = await queryDatabaseRows(this.prisma, {
        workspaceId: context.workspaceId,
        collectionDocumentId: input.collectionDocumentId,
        properties,
        filters,
        sorts,
        limit,
        offset,
      });
    } catch (error) {
      if (error instanceof UnknownDatabasePropertyError) {
        throw AppError.validation(error.message);
      }
      throw error;
    }

    const values = await this.prisma.documentPropertyValue.findMany({
      where: { documentId: { in: rows.map((row) => row.id) } },
    });
    const valuesByRow = new Map<string, StoredValueRow[]>();
    for (const value of values) {
      const list = valuesByRow.get(value.documentId);
      if (list === undefined) valuesByRow.set(value.documentId, [value]);
      else list.push(value);
    }

    const propertyList = [...properties.values()];
    const result: DatabaseRow[] = rows.map((row) => ({
      document: toSummary(row),
      values: propertyList.map((property) => ({
        propertyId: property.id,
        value: COMPUTED_TYPES.has(property.type)
          ? computedValue(property.type, row)
          : storedToResponseValue(
              property,
              valuesByRow.get(row.id)?.find((entry) => entry.propertyId === property.id),
            ),
      })),
    }));

    return {
      rows: result,
      nextCursor: rows.length === limit ? encodeCursor(offset + limit) : null,
    };
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
      await this.writeValues(input.collectionDocumentId, row.id, input.request.values);
    }

    return this.toRowResponse(input.collectionDocumentId, row.id);
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

    await this.writeValues(collectionDocumentId, input.rowId, input.request.values);
    return this.toRowResponse(collectionDocumentId, input.rowId);
  }

  private async writeValues(
    collectionDocumentId: string,
    rowId: string,
    values: DatabaseRowPropertyValue[],
  ): Promise<void> {
    const propertyRows = await this.prisma.databaseProperty.findMany({
      where: { documentId: collectionDocumentId },
      select: { id: true, type: true },
    });
    const properties = buildPropertyMap(propertyRows);

    await this.prisma.$transaction(
      values.map((entry) => {
        const property = properties.get(entry.propertyId);
        if (property === undefined) {
          throw AppError.validation(`Unknown property in this database: ${entry.propertyId}`);
        }
        if (COMPUTED_TYPES.has(property.type)) {
          throw AppError.validation(`${property.type} is computed and cannot be written directly`);
        }
        const columns = toColumnData(property, entry.value);
        return this.prisma.documentPropertyValue.upsert({
          where: { documentId_propertyId: { documentId: rowId, propertyId: entry.propertyId } },
          create: { documentId: rowId, propertyId: entry.propertyId, ...columns },
          update: columns,
        });
      }),
    );
  }

  private async toRowResponse(collectionDocumentId: string, rowId: string): Promise<DatabaseRow> {
    const [row, propertyRows, values] = await Promise.all([
      this.documents.loadDocumentOrThrow(rowId),
      this.prisma.databaseProperty.findMany({
        where: { documentId: collectionDocumentId },
        select: { id: true, type: true },
      }),
      this.prisma.documentPropertyValue.findMany({ where: { documentId: rowId } }),
    ]);

    return {
      document: toSummary(row),
      values: propertyRows.map((property) => ({
        propertyId: property.id,
        value: COMPUTED_TYPES.has(property.type)
          ? computedValue(property.type, row as unknown as DatabaseQueryRowRecord)
          : storedToResponseValue(
              property,
              values.find((entry) => entry.propertyId === property.id),
            ),
      })),
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
      return {
        // Re-parsed rather than cast: see the comment on `toResponse` in
        // database-views.service.ts.
        filters: databaseFilterGroupSchema.parse(view.filters),
        sorts: sortsArraySchema.parse(view.sorts),
      };
    }
    return {
      filters: request.filters ?? EMPTY_DATABASE_FILTER_GROUP,
      sorts: request.sorts ?? [],
    };
  }
}
