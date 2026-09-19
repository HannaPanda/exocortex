import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageDatabaseSchema,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  CONFIGURED_PROPERTY_TYPES,
  type CreateDatabasePropertyOptionRequest,
  type CreateDatabasePropertyRequest,
  databaseDatePropertyConfigSchema,
  type DatabaseOptionColor,
  type DatabaseProperty,
  type DatabasePropertyOption,
  type DatabasePropertyType,
  parseDatePropertyConfig,
  parseFormulaConfig,
  renameFormulaProperty,
  type ReorderDatabasePropertyRequest,
  type UpdateDatabasePropertyOptionRequest,
  type UpdateDatabasePropertyRequest,
} from '@exocortex/contracts';
import {
  type DatabasePropertyRef,
  generateOrderKey,
  loadDatabaseScope,
  type PendingSchemaChange,
  Prisma,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import {
  assertDerivedPropertiesCompile,
  normalizeDerivedConfig,
  PENDING_PROPERTY_ID,
  toDerivedRef,
} from './derived-properties';

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
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
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

    const config = await this.resolveConfigForType({
      type: input.request.type,
      config: input.request.config,
      collectionDocumentId: input.collectionDocumentId,
      workspaceId: context.workspaceId,
    });

    // Validated as if it already existed, so a formula that does not compile
    // is a refused request rather than a column the table cannot render.
    await this.assertSchemaStaysValid(input.collectionDocumentId, {
      upserts: [
        {
          id: PENDING_PROPERTY_ID,
          documentId: input.collectionDocumentId,
          type: input.request.type,
          name: input.request.name,
          config,
        },
      ],
    });

    const orderKey = await this.resolveOrderKey({
      documentId: input.collectionDocumentId,
      afterPropertyId: input.request.afterPropertyId ?? null,
      nullMeans: 'end',
    });

    const created = await this.prisma.databaseProperty.create({
      data: {
        documentId: input.collectionDocumentId,
        type: input.request.type,
        name: input.request.name,
        orderKey,
        ...(config === null ? {} : { config: config as Prisma.InputJsonValue }),
      },
      include: PROPERTY_INCLUDE,
    });

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: input.collectionDocumentId,
      },
    );
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

    if (property.type === 'DATE' && input.request.config !== undefined) {
      await this.assertDateConfigChangeIsSafe(
        input.propertyId,
        property.config,
        input.request.config,
      );
    }

    const nextConfig =
      input.request.config === undefined
        ? (property.config as Record<string, unknown> | null)
        : await this.resolveConfigForType({
            type: property.type,
            config: input.request.config,
            collectionDocumentId: property.documentId,
            workspaceId: context.workspaceId,
          });
    const nextName = input.request.name ?? property.name;

    // A rename reaches the formulas that spell the old name out, before the
    // validation below would call them broken.
    const rewrites =
      nextName === property.name
        ? []
        : await this.formulaRewritesForRename(property.documentId, property.name, nextName);

    await this.assertSchemaStaysValid(property.documentId, {
      upserts: [
        {
          id: property.id,
          documentId: property.documentId,
          type: property.type,
          name: nextName,
          config: nextConfig,
        },
        ...rewrites,
      ],
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const rewrite of rewrites) {
        await tx.databaseProperty.update({
          where: { id: rewrite.id },
          data: { config: (rewrite.config ?? {}) as Prisma.InputJsonValue },
        });
      }
      return tx.databaseProperty.update({
        where: { id: input.propertyId },
        data: {
          ...(input.request.name === undefined ? {} : { name: input.request.name }),
          ...(input.request.config === undefined
            ? {}
            : {
                config:
                  nextConfig === null ? Prisma.JsonNull : (nextConfig as Prisma.InputJsonValue),
              }),
        },
        include: PROPERTY_INCLUDE,
      });
    });

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: property.documentId,
      },
    );
    return toResponse(updated);
  }

  /**
   * A DATE property's config decides the response shape of every one of its
   * values, so the two ways of getting it wrong are checked before the write:
   *
   * 1. A malformed bag would leave the property answering in whatever shape
   *    `parseDatePropertyConfig`'s fallback happens to produce.
   * 2. Turning `isRange` off while rows still carry an end would make those
   *    ends unreachable through the API, which reads as data loss even though
   *    the column keeps them. Refused with a count rather than done silently;
   *    clearing the ends first is the caller's decision, not ours.
   */
  private async assertDateConfigChangeIsSafe(
    propertyId: string,
    currentConfig: Prisma.JsonValue,
    nextConfig: Record<string, unknown> | null,
  ): Promise<void> {
    const parsed = databaseDatePropertyConfigSchema.safeParse(nextConfig ?? {});
    if (!parsed.success) {
      throw AppError.validation(
        'A DATE property config accepts only { includeTime, isRange, timeZone }',
      );
    }
    const wasRange = parseDatePropertyConfig(
      currentConfig as Record<string, unknown> | null,
    ).isRange;
    if (!wasRange || parsed.data.isRange) return;

    const withEnd = await this.prisma.documentPropertyValue.count({
      where: { propertyId, dateEndValue: { not: null } },
    });
    if (withEnd > 0) {
      throw new AppError(
        'database_property_date_range_in_use',
        `${withEnd} value(s) of this property have an end date; clear them before turning the span off`,
      );
    }
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

    const orderKey = await this.resolveOrderKey({
      documentId: property.documentId,
      afterPropertyId: input.request.afterPropertyId,
      nullMeans: 'start',
      excludePropertyId: input.propertyId,
    });

    const updated = await this.prisma.databaseProperty.update({
      where: { id: input.propertyId },
      data: { orderKey },
      include: PROPERTY_INCLUDE,
    });

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: property.documentId,
      },
    );
    return toResponse(updated);
  }

  /**
   * Deletes a property. The one genuinely destructive operation in this
   * feature — every row silently loses its value for it, with no undo — so it
   * is audited and its cascade (`DocumentPropertyValue`, `DatabasePropertyOption`)
   * runs in the same transaction as the audit write.
   */
  async delete(input: {
    propertyId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ deleted: true }> {
    const property = await this.loadPropertyOrThrow(input.propertyId);
    const context = await this.requireCollection(property.documentId, input.userId);
    assertPolicy(canManageDatabaseSchema(context.role, context.document));

    // A rollup aggregating over this column, or a formula naming it, would be
    // left pointing at nothing. Refused here with the offending column in the
    // message, because the alternative is a table that stops rendering.
    await this.assertSchemaStaysValid(property.documentId, { omit: input.propertyId });

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

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: property.documentId,
      },
    );
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

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: property.documentId,
      },
    );
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

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: option.property.documentId,
      },
    );
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

    await this.realtime.emit(
      'database.property.changed',
      context.workspaceId,
      input.correlationId,
      {
        documentId: option.property.documentId,
      },
    );
    return { deleted: true };
  }

  /**
   * The `config` to store for a property of this type.
   *
   * RELATION, ROLLUP and FORMULA carry their whole meaning in it, so an
   * absent one is refused rather than stored as a column that means nothing.
   * Every other type keeps the old behaviour: the bag is whatever the caller
   * sent, and the DATE check above is the only one that looks inside it.
   */
  private async resolveConfigForType(input: {
    type: DatabasePropertyType;
    config: Record<string, unknown> | null | undefined;
    collectionDocumentId: string;
    workspaceId: string;
  }): Promise<Record<string, unknown> | null> {
    const configured = CONFIGURED_PROPERTY_TYPES.includes(
      input.type as (typeof CONFIGURED_PROPERTY_TYPES)[number],
    );
    if (!configured) return input.config ?? null;
    return normalizeDerivedConfig({
      prisma: this.prisma,
      type: input.type,
      config: input.config,
      collectionDocumentId: input.collectionDocumentId,
      workspaceId: input.workspaceId,
    });
  }

  /** Every derived column of this database still compiles once `pending` is applied. */
  private async assertSchemaStaysValid(
    collectionDocumentId: string,
    pending: PendingSchemaChange,
  ): Promise<void> {
    assertDerivedPropertiesCompile(
      await loadDatabaseScope(this.prisma, collectionDocumentId, pending),
      pending.omit === undefined ? 'database_property_config_invalid' : 'database_property_in_use',
    );
  }

  /**
   * The formula columns of this database with the old column name swapped for
   * the new one. Returned rather than written, so the same list can be handed
   * to the validation and then to the transaction that performs the rename.
   */
  private async formulaRewritesForRename(
    collectionDocumentId: string,
    from: string,
    to: string,
  ): Promise<DatabasePropertyRef[]> {
    const formulas = await this.prisma.databaseProperty.findMany({
      where: { documentId: collectionDocumentId, type: 'FORMULA' },
      select: { id: true, documentId: true, type: true, name: true, config: true },
    });

    const rewrites: DatabasePropertyRef[] = [];
    for (const row of formulas) {
      const ref = toDerivedRef(row);
      const config = parseFormulaConfig(ref.config);
      if (config === null) continue;
      const expression = renameFormulaProperty(config.expression, from, to);
      if (expression === config.expression) continue;
      rewrites.push({ ...ref, config: { ...config, expression } });
    }
    return rewrites;
  }

  private async loadPropertyOrThrow(propertyId: string): Promise<{
    id: string;
    documentId: string;
    name: string;
    type: DatabasePropertyType;
    config: Prisma.JsonValue;
  }> {
    const property = await this.prisma.databaseProperty.findUnique({
      where: { id: propertyId },
      select: { id: true, documentId: true, name: true, type: true, config: true },
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

  private async resolveOrderKey(input: {
    documentId: string;
    afterPropertyId: string | null;
    /**
     * What `afterPropertyId: null` means, because the two callers disagree: a
     * new property is appended at the `end`, while reordering to "after
     * nothing" moves the property to the `start` (the same reading
     * `DatabaseViewsService.resolveOrderKey` uses for views).
     */
    nullMeans: 'end' | 'start';
    excludePropertyId?: string;
  }): Promise<string> {
    const siblings = await this.prisma.databaseProperty.findMany({
      where: {
        documentId: input.documentId,
        ...(input.excludePropertyId === undefined ? {} : { id: { not: input.excludePropertyId } }),
      },
      select: { id: true, orderKey: true },
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });
    if (siblings.length === 0) return generateOrderKey(null, null);

    if (input.afterPropertyId === null) {
      return input.nullMeans === 'end'
        ? generateOrderKey(siblings[siblings.length - 1]?.orderKey ?? null, null)
        : generateOrderKey(null, siblings[0]?.orderKey ?? null);
    }
    const index = siblings.findIndex((sibling) => sibling.id === input.afterPropertyId);
    if (index < 0) throw AppError.notFound('Sibling property');
    return generateOrderKey(
      siblings[index]?.orderKey ?? null,
      siblings[index + 1]?.orderKey ?? null,
    );
  }
}
