import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { assertPolicy, canManageDatabaseSchema, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CreateDatabaseViewRequest,
  databaseFilterGroupSchema,
  databaseSortSchema,
  type DatabaseView,
  databaseViewConfigSchema,
  EMPTY_DATABASE_FILTER_GROUP,
  type ReorderDatabaseViewRequest,
  type UpdateDatabaseViewRequest,
} from '@exocortex/contracts';
import { generateOrderKey, type Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

type ViewRow = Prisma.DatabaseViewGetPayload<object>;

const sortsArraySchema = z.array(databaseSortSchema);

/**
 * `DatabaseFilterGroup`/`DatabaseSort[]` are hand-written recursive
 * interfaces (needed for `z.lazy`), so they have no index signature and are
 * not structurally assignable to Prisma's `InputJsonValue`. The values are
 * already validated by the contract's zod schema before they ever reach this
 * function, so this is a safe boundary cast, not a type-safety escape hatch.
 */
function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/**
 * `filters`/`sorts`/`config` are stored as validated JSON, but Prisma's column
 * type is the untyped `Json`. Re-parsing with the same zod schemas the write
 * path already validated against (rather than casting) means a hand-edited
 * row in the database can never hand the query engine a shape it wasn't
 * built to handle.
 */
function toResponse(row: ViewRow): DatabaseView {
  return {
    id: row.id,
    documentId: row.documentId,
    type: row.type,
    name: row.name,
    orderKey: row.orderKey,
    filters: databaseFilterGroupSchema.parse(row.filters),
    sorts: sortsArraySchema.parse(row.sorts),
    groupByPropertyId: row.groupByPropertyId,
    config: databaseViewConfigSchema.parse(row.config),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Manages saved views (Table/Board/Gallery/Calendar) of a database. Row
 * querying itself lives in `DatabaseRowsService`, which is what actually
 * evaluates a view's `filters`/`sorts` against `document_property_value`.
 */
@Injectable()
export class DatabaseViewsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(collectionDocumentId: string, userId: string): Promise<DatabaseView[]> {
    const context = await this.requireCollection(collectionDocumentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const rows = await this.prisma.databaseView.findMany({
      where: { documentId: collectionDocumentId },
      orderBy: { orderKey: 'asc' },
    });
    return rows.map(toResponse);
  }

  async create(input: {
    collectionDocumentId: string;
    userId: string;
    request: CreateDatabaseViewRequest;
    correlationId: string;
  }): Promise<DatabaseView> {
    const context = await this.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const last = await this.prisma.databaseView.findFirst({
      where: { documentId: input.collectionDocumentId },
      orderBy: { orderKey: 'desc' },
      select: { orderKey: true },
    });

    const created = await this.prisma.databaseView.create({
      data: {
        documentId: input.collectionDocumentId,
        type: input.request.type,
        name: input.request.name,
        orderKey: generateOrderKey(last?.orderKey ?? null, null),
        filters: toJsonInput(EMPTY_DATABASE_FILTER_GROUP),
        sorts: [],
        config: { visibleProperties: [] },
      },
    });

    await this.realtime.emit('database.view.changed', context.workspaceId, input.correlationId, {
      documentId: input.collectionDocumentId,
    });
    return toResponse(created);
  }

  async update(input: {
    viewId: string;
    userId: string;
    request: UpdateDatabaseViewRequest;
    correlationId: string;
  }): Promise<DatabaseView> {
    const view = await this.loadViewOrThrow(input.viewId);
    const context = await this.requireCollection(view.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const existingConfig = databaseViewConfigSchema.parse(view.config);
    const nextConfig =
      input.request.config === undefined ? existingConfig : { ...existingConfig, ...input.request.config };

    const updated = await this.prisma.databaseView.update({
      where: { id: input.viewId },
      data: {
        ...(input.request.name === undefined ? {} : { name: input.request.name }),
        ...(input.request.filters === undefined ? {} : { filters: toJsonInput(input.request.filters) }),
        ...(input.request.sorts === undefined ? {} : { sorts: toJsonInput(input.request.sorts) }),
        ...(input.request.groupByPropertyId === undefined
          ? {}
          : { groupByPropertyId: input.request.groupByPropertyId }),
        ...(input.request.config === undefined ? {} : { config: toJsonInput(nextConfig) }),
      },
    });

    await this.realtime.emit('database.view.changed', context.workspaceId, input.correlationId, {
      documentId: view.documentId,
    });
    return toResponse(updated);
  }

  async reorder(input: {
    viewId: string;
    userId: string;
    request: ReorderDatabaseViewRequest;
    correlationId: string;
  }): Promise<DatabaseView> {
    const view = await this.loadViewOrThrow(input.viewId);
    const context = await this.requireCollection(view.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const siblings = await this.prisma.databaseView.findMany({
      where: { documentId: view.documentId, id: { not: input.viewId } },
      select: { id: true, orderKey: true },
      orderBy: { orderKey: 'asc' },
    });

    let orderKey: string;
    if (input.request.afterViewId === null) {
      orderKey = generateOrderKey(null, siblings[0]?.orderKey ?? null);
    } else {
      const index = siblings.findIndex((sibling) => sibling.id === input.request.afterViewId);
      if (index < 0) throw AppError.notFound('Sibling view');
      orderKey = generateOrderKey(siblings[index]?.orderKey ?? null, siblings[index + 1]?.orderKey ?? null);
    }

    const updated = await this.prisma.databaseView.update({
      where: { id: input.viewId },
      data: { orderKey },
    });

    await this.realtime.emit('database.view.changed', context.workspaceId, input.correlationId, {
      documentId: view.documentId,
    });
    return toResponse(updated);
  }

  async delete(input: { viewId: string; userId: string; correlationId: string }): Promise<{ deleted: true }> {
    const view = await this.loadViewOrThrow(input.viewId);
    const context = await this.requireCollection(view.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    await this.prisma.databaseView.delete({ where: { id: input.viewId } });

    await this.realtime.emit('database.view.changed', context.workspaceId, input.correlationId, {
      documentId: view.documentId,
    });
    return { deleted: true };
  }

  private async loadViewOrThrow(viewId: string): Promise<ViewRow> {
    const view = await this.prisma.databaseView.findUnique({ where: { id: viewId } });
    if (view === null) throw AppError.notFound('Database view');
    return view;
  }

  private async requireCollection(documentId: string, userId: string) {
    const context = await this.access.requireDocumentContext(documentId, userId);
    if (context.document.type !== 'COLLECTION') {
      throw AppError.validation('Document is not a database');
    }
    return context;
  }
}
