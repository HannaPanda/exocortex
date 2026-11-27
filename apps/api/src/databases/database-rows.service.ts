import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  canReadDocument,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateDatabaseRowRequest,
  type DatabaseFilterGroup,
  databaseFilterGroupSchema,
  type DatabaseRow,
  type DatabaseRowFile,
  type DatabaseRowPropertyValue,
  type DatabaseRowsResponse,
  type DatabaseSort,
  databaseSortSchema,
  type DocumentRowResponse,
  EMPTY_DATABASE_FILTER_GROUP,
  type QueryDatabaseRowsRequest,
  type QueryDatabaseRowsResponse,
  type UpdateDatabaseRowsRequest,
  type UpdateDatabaseRowValuesRequest,
} from '@exocortex/contracts';
import {
  type DatabasePropertyRef,
  type DatabaseQueryRowRecord,
  type DatabaseQueryScope,
  derivedDateIsWholeDay,
  derivedPropertiesOf,
  DerivedPropertyError,
  formulaTypeOf,
  InvalidDatabaseFilterError,
  isDerivedColumn,
  loadDatabaseScope,
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

import { listDatabaseProperties } from './database-properties.service';
import { normalizeRelationValue } from './derived-properties';
import {
  type ColumnData,
  COMPUTED_TYPES,
  computedValue,
  decodeCursor,
  derivedToResponseValue,
  encodeCursor,
  filesOfRow,
  storedToResponseValue,
  type StoredValueRow,
  toColumnData,
} from './row-values';

const sortsArraySchema = z.array(databaseSortSchema);

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
    const files = await this.filesNamedBy(values, scope);
    const result: DatabaseRow[] = rows.map((row) => {
      const rowValues = propertyList.map((property) =>
        this.toValue(property, scope, {
          row,
          stored: valuesByRow.get(row.id)?.find((entry) => entry.propertyId === property.id),
          derived: derived.get(row.id)?.get(property.id),
        }),
      );
      return {
        document: toSummary(row),
        values: rowValues,
        ...filesOfRow(rowValues, scope, files),
      };
    });

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
        value: derivedToResponseValue(
          formulaTypeOf(property, scope.schema),
          sources.derived,
          derivedDateIsWholeDay(property, scope.schema),
        ),
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
        rowIds: [row.id],
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
    return (await this.describeDocumentRow(documentId, userId)).row;
  }

  /**
   * The row a document is, together with the columns of its database (issue
   * #254): what a page header needs to show and edit the row's values.
   *
   * The columns come with the row on the row's own right. The page may be all
   * the reader holds -- a single page shared with them (ADR-044) -- and the
   * values are unreadable without their names, types and options; the schema
   * of the row they may read is part of reading it, while the database's other
   * rows stay behind its own check.
   */
  async describeDocumentRow(documentId: string, userId: string): Promise<DocumentRowResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const collectionDocumentId = context.document.parentId;
    if (collectionDocumentId === null) return { row: null, properties: [] };

    const parent = await this.prisma.document.findUnique({
      where: { id: collectionDocumentId },
      select: { type: true },
    });
    if (parent === null || parent.type !== 'COLLECTION') return { row: null, properties: [] };

    const [row, properties] = await Promise.all([
      this.toRowResponse(collectionDocumentId, documentId),
      listDatabaseProperties(this.prisma, collectionDocumentId),
    ]);
    return { row, properties };
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
      rowIds: [input.rowId],
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
   * One set of values for several rows of one database at once (issue #244):
   * "Status: erledigt" for the twelve rows somebody selected.
   *
   * All or nothing. Every row is checked before anything is written -- that
   * it is a live row of this database and that the caller may edit it, each on
   * its own, because a share can reach one row and not its neighbour
   * (ADR-044) -- and the values of all of them are written in one
   * transaction, so a refusal on the ninth row leaves the first eight as they
   * were instead of half the selection changed.
   */
  async updateMany(input: {
    collectionDocumentId: string;
    userId: string;
    request: UpdateDatabaseRowsRequest;
    correlationId: string;
  }): Promise<DatabaseRowsResponse> {
    const collection = await this.requireCollection(input.collectionDocumentId, input.userId);
    const rowIds = [...new Set(input.request.rowIds)];
    await this.requireRowsOf({
      collectionDocumentId: input.collectionDocumentId,
      rowIds,
      userId: input.userId,
      check: (context) => assertPolicy(canEditDocument(context.role, context.document)),
    });

    await this.writeValues({
      collectionDocumentId: input.collectionDocumentId,
      rowIds,
      values: input.request.values,
      workspaceId: collection.workspaceId,
      correlationId: input.correlationId,
    });
    for (const rowId of rowIds) {
      await this.realtime.emit(
        'database.row.updated',
        collection.workspaceId,
        input.correlationId,
        {
          documentId: input.collectionDocumentId,
          rowId,
        },
      );
    }

    return {
      rows: await Promise.all(
        rowIds.map((rowId) => this.toRowResponse(input.collectionDocumentId, rowId)),
      ),
    };
  }

  /**
   * Refuses unless every id is a row of this database that is not in the
   * trash, and `check` passes for each row's own access context.
   *
   * The rows are named in the refusal, so a client that sent a stale
   * selection learns which of them is gone rather than that something was.
   */
  async requireRowsOf(input: {
    collectionDocumentId: string;
    rowIds: readonly string[];
    userId: string;
    check: (context: DocumentAccessContext) => void;
  }): Promise<void> {
    const found = await this.prisma.document.findMany({
      where: {
        id: { in: [...input.rowIds] },
        parentId: input.collectionDocumentId,
        type: 'PAGE',
        archivedAt: null,
      },
      select: { id: true },
    });
    const live = new Set(found.map((row) => row.id));
    const missing = input.rowIds.filter((id) => !live.has(id));
    if (missing.length > 0) {
      throw new AppError(
        'database_rows_not_found',
        'Not every id is a row of this database outside the trash',
        { rowIds: missing },
      );
    }
    for (const rowId of input.rowIds) {
      input.check(await this.access.requireDocumentContext(rowId, input.userId));
    }
  }

  /**
   * Writes property values into one or more rows, and records that they
   * changed.
   *
   * An interactive transaction rather than an array of upserts, because the
   * outbox row has to be written inside the same transaction as the values it
   * describes (ADR-010). Without that event nothing downstream can react to a
   * row changing: an automation scoped to a database would only ever see rows
   * being created and renamed, never filled in, which is most of what happens
   * to a row (issue #50). Several rows get one event each, because a rule
   * reacts to a row, not to a request.
   *
   * `workspaceId` is threaded through rather than looked up here: every caller
   * has already resolved the row's access context, and a second lookup would be
   * a second chance to disagree about which workspace this is.
   */
  private async writeValues(input: {
    collectionDocumentId: string;
    rowIds: readonly string[];
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
    // A FILES value is checked per row, since the files have to hang on it.
    const writes = await Promise.all(
      input.rowIds.map(async (rowId) => ({
        rowId,
        columns: await Promise.all(
          input.values.map((entry) => this.prepareWrite(scope, rowId, entry)),
        ),
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      for (const row of writes) {
        for (const write of row.columns) {
          await tx.documentPropertyValue.upsert({
            where: {
              documentId_propertyId: { documentId: row.rowId, propertyId: write.propertyId },
            },
            create: { documentId: row.rowId, propertyId: write.propertyId, ...write.columns },
            update: write.columns,
          });
        }

        await this.outbox.writeEvent(tx, {
          workspaceId: input.workspaceId,
          type: 'database.row.updated',
          payload: { documentId: input.collectionDocumentId, rowId: row.rowId },
          correlationId: input.correlationId,
        });
      }
    });
  }

  /** One `{propertyId, value}` as the typed columns it is stored in, checked. */
  private async prepareWrite(
    scope: DatabaseQueryScope,
    rowId: string,
    entry: DatabaseRowPropertyValue,
  ): Promise<{ propertyId: string; columns: ColumnData }> {
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
        : property.type === 'FILES' && Array.isArray(entry.value)
          ? await this.normalizeFilesValue({ rowId, propertyId: property.id, value: entry.value })
          : entry.value;
    return { propertyId: entry.propertyId, columns: toColumnData(property, value) };
  }

  async toRowResponse(collectionDocumentId: string, rowId: string): Promise<DatabaseRow> {
    const [row, scope, values] = await Promise.all([
      this.documents.loadDocumentOrThrow(rowId),
      loadDatabaseScope(this.prisma, collectionDocumentId),
      this.prisma.documentPropertyValue.findMany({ where: { documentId: rowId } }),
    ]);
    const [derivedValues, files] = await Promise.all([
      this.readDerivedValues([rowId], scope),
      this.filesNamedBy(values, scope),
    ]);
    const derived = derivedValues.get(rowId);

    const rowValues = [...scope.properties.values()].map((property) =>
      this.toValue(property, scope, {
        row: row as unknown as DatabaseQueryRowRecord,
        stored: values.find((entry) => entry.propertyId === property.id),
        derived: derived?.get(property.id),
      }),
    );
    return { document: toSummary(row), values: rowValues, ...filesOfRow(rowValues, scope, files) };
  }

  /**
   * Name, type and size of every file the FILES values among `values` name
   * (issue #245), by id. A file that was deleted is simply not in the map,
   * which is how a cell learns that it is gone.
   */
  private async filesNamedBy(
    values: readonly StoredValueRow[],
    scope: DatabaseQueryScope,
  ): Promise<Map<string, DatabaseRowFile>> {
    const ids = new Set<string>();
    for (const value of values) {
      if (scope.properties.get(value.propertyId)?.type !== 'FILES') continue;
      if (!Array.isArray(value.jsonValue)) continue;
      for (const id of value.jsonValue) if (typeof id === 'string') ids.add(id);
    }
    if (ids.size === 0) return new Map();
    const rows = await this.prisma.attachment.findMany({
      where: { id: { in: [...ids] }, deletedAt: null },
      select: { id: true, filename: true, mimeType: true, byteSize: true },
    });
    return new Map(rows.map((row) => [row.id, row] as const));
  }

  /**
   * A FILES value as written, checked (issue #245): ids once each, and every
   * id the cell does not already hold must be a file uploaded onto this row.
   * Ids it already holds may stay even when they hang elsewhere, which is
   * what a row made from a template holds (ADR-039), so removing one of
   * several files never fails on the others.
   */
  private async normalizeFilesValue(input: {
    rowId: string;
    propertyId: string;
    value: string[];
  }): Promise<string[] | null> {
    const ids = [...new Set(input.value)];
    if (ids.length === 0) return null;
    const stored = await this.prisma.documentPropertyValue.findUnique({
      where: { documentId_propertyId: { documentId: input.rowId, propertyId: input.propertyId } },
      select: { jsonValue: true },
    });
    const held = new Set(
      Array.isArray(stored?.jsonValue)
        ? stored.jsonValue.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const added = ids.filter((id) => !held.has(id));
    if (added.length === 0) return ids;
    const own = await this.prisma.attachment.findMany({
      where: {
        id: { in: added },
        documentId: input.rowId,
        deletedAt: null,
        conversationId: null,
      },
      select: { id: true },
    });
    const ownIds = new Set(own.map((row) => row.id));
    const foreign = added.filter((id) => !ownIds.has(id));
    if (foreign.length > 0) {
      throw new AppError(
        'database_files_foreign',
        'A FILES value may only add files uploaded onto this row; upload with documentId set to the row and propertyId set to the column',
        { attachmentIds: foreign },
      );
    }
    return ids;
  }

  async requireCollection(documentId: string, userId: string) {
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
