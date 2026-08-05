import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageDatabaseSchema, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CreateDatabasePropertyOptionRequest,
  type CreateDatabasePropertyRequest,
  type DatabaseOptionColor,
  type DatabaseProperty,
  type DatabasePropertyOption,
  IMPLEMENTED_PROPERTY_TYPES,
  type ReorderDatabasePropertyRequest,
  type UpdateDatabasePropertyOptionRequest,
  type UpdateDatabasePropertyRequest,
} from '@exocortex/contracts';
import { generateOrderKey, type Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

const PROPERTY_INCLUDE = { options: true } as const;

type PropertyWithOptions = Prisma.DatabasePropertyGetPayload<{ include: typeof PROPERTY_INCLUDE }>;
type OptionRow = Prisma.DatabasePropertyOptionGetPayload<object>;

/**
 * Prisma models `color` as a plain, unconstrained `String` column (see
 * schema.prisma) because a Prisma-level enum would need its own migration
 * every time a colour is added; the nine allowed values are enforced only at
 * the contract boundary (`databaseOptionColorSchema`). This function is the
 * single place that bridges the two: every write already went through that
 * schema, so the value is always one of the nine — no `any`, one narrow,
 * documented cast at the read boundary instead of scattering it everywhere.
 */
function toOptionColor(color: string): DatabaseOptionColor {
  return color as DatabaseOptionColor;
}

function toOptionResponse(option: OptionRow): DatabasePropertyOption {
  return {
    id: option.id,
    label: option.label,
    color: toOptionColor(option.color),
    orderKey: option.orderKey,
  };
}

function toResponse(row: PropertyWithOptions): DatabaseProperty {
  return {
    id: row.id,
    documentId: row.documentId,
    type: row.type,
    name: row.name,
    orderKey: row.orderKey,
    config: row.config as Record<string, unknown> | null,
    options: row.options
      .slice()
      .sort((a, b) => (a.orderKey < b.orderKey ? -1 : 1))
      .map(toOptionResponse),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Manages the typed schema of a database (a `Document` with `type: 'COLLECTION'`):
 * its properties and their SELECT/MULTI_SELECT options. Row values live in
 * `DatabaseRowsService`; views live in `DatabaseViewsService`.
 */
@Injectable()
export class DatabasePropertiesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(collectionDocumentId: string, userId: string): Promise<DatabaseProperty[]> {
    const context = await this.requireCollection(collectionDocumentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const rows = await this.prisma.databaseProperty.findMany({
      where: { documentId: collectionDocumentId },
      include: PROPERTY_INCLUDE,
      orderBy: { orderKey: 'asc' },
    });
    return rows.map(toResponse);
  }

  async create(input: {
    collectionDocumentId: string;
    userId: string;
    request: CreateDatabasePropertyRequest;
    correlationId: string;
  }): Promise<DatabaseProperty> {
    const context = await this.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    if (!IMPLEMENTED_PROPERTY_TYPES.includes(input.request.type as (typeof IMPLEMENTED_PROPERTY_TYPES)[number])) {
      throw new AppError(
        'database_property_reserved',
        `Property type ${input.request.type} is reserved for a later round and cannot be created yet`,
      );
    }

    const orderKey = await this.resolveOrderKey(
      input.collectionDocumentId,
      input.request.afterPropertyId ?? null,
    );

    const created = await this.prisma.databaseProperty.create({
      data: {
        documentId: input.collectionDocumentId,
        type: input.request.type,
        name: input.request.name,
        orderKey,
      },
      include: PROPERTY_INCLUDE,
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: input.collectionDocumentId,
    });
    return toResponse(created);
  }

  async update(input: {
    propertyId: string;
    userId: string;
    request: UpdateDatabasePropertyRequest;
    correlationId: string;
  }): Promise<DatabaseProperty> {
    const property = await this.loadPropertyOrThrow(input.propertyId);
    const context = await this.requireCollection(property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const updated = await this.prisma.databaseProperty.update({
      where: { id: input.propertyId },
      data: {
        ...(input.request.name === undefined ? {} : { name: input.request.name }),
        ...(input.request.config === undefined
          ? {}
          : { config: input.request.config as Prisma.InputJsonValue | typeof Prisma.JsonNull }),
      },
      include: PROPERTY_INCLUDE,
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: property.documentId,
    });
    return toResponse(updated);
  }

  async reorder(input: {
    propertyId: string;
    userId: string;
    request: ReorderDatabasePropertyRequest;
    correlationId: string;
  }): Promise<DatabaseProperty> {
    const property = await this.loadPropertyOrThrow(input.propertyId);
    const context = await this.requireCollection(property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const orderKey = await this.resolveOrderKey(
      property.documentId,
      input.request.afterPropertyId,
      input.propertyId,
    );

    const updated = await this.prisma.databaseProperty.update({
      where: { id: input.propertyId },
      data: { orderKey },
      include: PROPERTY_INCLUDE,
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: property.documentId,
    });
    return toResponse(updated);
  }

  /**
   * Deletes a property. The one genuinely destructive operation in this
   * feature — every row silently loses its value for it, with no undo — so it
   * is audited and its cascade (`DocumentPropertyValue`, `DatabasePropertyOption`)
   * runs in the same transaction as the audit write.
   */
  async delete(input: { propertyId: string; userId: string; correlationId: string }): Promise<{ deleted: true }> {
    const property = await this.loadPropertyOrThrow(input.propertyId);
    const context = await this.requireCollection(property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    await this.prisma.$transaction(async (tx) => {
      await this.outbox.writeAudit(tx, {
        workspaceId: context.workspaceId,
        actorId: input.userId,
        action: 'database.property.deleted',
        targetType: 'database_property',
        targetId: input.propertyId,
        correlationId: input.correlationId,
        metadata: { collectionDocumentId: property.documentId, name: property.name },
      });
      await tx.databaseProperty.delete({ where: { id: input.propertyId } });
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: property.documentId,
    });
    return { deleted: true };
  }

  async createOption(input: {
    propertyId: string;
    userId: string;
    request: CreateDatabasePropertyOptionRequest;
    correlationId: string;
  }): Promise<DatabasePropertyOption> {
    const property = await this.loadPropertyOrThrow(input.propertyId);
    const context = await this.requireCollection(property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const last = await this.prisma.databasePropertyOption.findFirst({
      where: { propertyId: input.propertyId },
      orderBy: { orderKey: 'desc' },
      select: { orderKey: true },
    });

    const option = await this.prisma.databasePropertyOption.create({
      data: {
        propertyId: input.propertyId,
        label: input.request.label,
        color: input.request.color,
        orderKey: generateOrderKey(last?.orderKey ?? null, null),
      },
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: property.documentId,
    });
    return toOptionResponse(option);
  }

  async updateOption(input: {
    optionId: string;
    userId: string;
    request: UpdateDatabasePropertyOptionRequest;
    correlationId: string;
  }): Promise<DatabasePropertyOption> {
    const option = await this.prisma.databasePropertyOption.findUnique({
      where: { id: input.optionId },
      include: { property: { select: { documentId: true } } },
    });
    if (option === null) throw AppError.notFound('Property option');
    const context = await this.requireCollection(option.property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    const updated = await this.prisma.databasePropertyOption.update({
      where: { id: input.optionId },
      data: {
        ...(input.request.label === undefined ? {} : { label: input.request.label }),
        ...(input.request.color === undefined ? {} : { color: input.request.color }),
      },
    });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: option.property.documentId,
    });
    return toOptionResponse(updated);
  }

  async deleteOption(input: {
    optionId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ deleted: true }> {
    const option = await this.prisma.databasePropertyOption.findUnique({
      where: { id: input.optionId },
      include: { property: { select: { documentId: true } } },
    });
    if (option === null) throw AppError.notFound('Property option');
    const context = await this.requireCollection(option.property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    await this.prisma.databasePropertyOption.delete({ where: { id: input.optionId } });

    await this.realtime.emit('database.property.changed', context.workspaceId, input.correlationId, {
      documentId: option.property.documentId,
    });
    return { deleted: true };
  }

  private async loadPropertyOrThrow(propertyId: string): Promise<{ id: string; documentId: string; name: string }> {
    const property = await this.prisma.databaseProperty.findUnique({
      where: { id: propertyId },
      select: { id: true, documentId: true, name: true },
    });
    if (property === null) throw AppError.notFound('Database property');
    return property;
  }

  /** Loads the collection document and rejects non-COLLECTION documents. */
  private async requireCollection(documentId: string, userId: string) {
    const context = await this.access.requireDocumentContext(documentId, userId);
    if (context.document.type !== 'COLLECTION') {
      throw AppError.validation('Document is not a database');
    }
    return context;
  }

  private async resolveOrderKey(
    documentId: string,
    afterPropertyId: string | null,
    excludePropertyId?: string,
  ): Promise<string> {
    const siblings = await this.prisma.databaseProperty.findMany({
      where: {
        documentId,
        ...(excludePropertyId === undefined ? {} : { id: { not: excludePropertyId } }),
      },
      select: { id: true, orderKey: true },
      orderBy: { orderKey: 'asc' },
    });
    if (siblings.length === 0) return generateOrderKey(null, null);

    if (afterPropertyId === null) {
      return generateOrderKey(siblings[siblings.length - 1]?.orderKey ?? null, null);
    }
    const index = siblings.findIndex((sibling) => sibling.id === afterPropertyId);
    if (index < 0) throw AppError.notFound('Sibling property');
    return generateOrderKey(siblings[index]?.orderKey ?? null, siblings[index + 1]?.orderKey ?? null);
  }
}
