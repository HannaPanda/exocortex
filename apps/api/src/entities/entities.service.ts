import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CreateEntityRequest,
  type DatabaseOptionColor,
  ENTITY_PROPERTY_NAMES,
  ENTITY_TYPE_LABELS,
  type EntityListQuery,
  type EntityListResponse,
  type EntityMutationResponse,
  type EntitySummary,
  type EntityType,
  entityTypeSchema,
  type LinkEntityPageRequest,
  type ProvisionEntityDatabaseRequest,
  type ProvisionEntityDatabaseResponse,
  QUEUE_NAMES,
  type UpdateEntityRequest,
} from '@exocortex/contracts';
import { type EntityRecord, type PrismaClient } from '@exocortex/database';
import { entityAliasKey, formatEntityAliases } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { DatabasePropertiesService } from '../databases/database-properties.service';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { EntityRegistryService } from './entity-registry.service';

/** Colour each type's SELECT option gets when the database is provisioned. */
const TYPE_COLOURS: Record<EntityType, DatabaseOptionColor> = {
  person: 'blue',
  host: 'purple',
  service: 'green',
  project: 'yellow',
  credential: 'red',
  organisation: 'brown',
  other: 'gray',
};

/**
 * Managing entities (issue #47).
 *
 * Every write here goes through the ordinary document and database services
 * rather than through Prisma: an entity is a database row, so creating one must
 * pass the same permission checks, land in the same outbox and reach an open
 * editor through the same collaboration bridge as a row somebody adds by hand
 * (ADR-016). Nothing about an entity is privileged.
 */
@Injectable()
export class EntitiesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly settings: SettingsService,
    private readonly registry: EntityRegistryService,
    private readonly access: WorkspaceAccessService,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
    private readonly properties: DatabasePropertiesService,
  ) {}

  async list(userId: string, query: EntityListQuery): Promise<EntityListResponse> {
    const databaseId = await this.registry.databaseId();
    const entities = await this.registry.loadReadable(userId);
    const readable = await this.registry.readableWorkspaceIds(userId);
    const counts = await this.registry.mentionCounts(
      entities.map((entity) => entity.id),
      readable,
    );

    const needle = query.q === undefined ? null : entityAliasKey(query.q);
    const filtered = entities
      .filter((entity) => query.type === undefined || entity.type === query.type)
      .filter((entity) => needle === null || matchesNeedle(entity, needle))
      .slice(0, query.limit);

    return {
      databaseId,
      entities: filtered.map((entity) =>
        this.registry.toSummary(entity, counts.get(entity.id) ?? 0),
      ),
    };
  }

  /**
   * Creates the entity database and points the deployment at it.
   *
   * Idempotent by way of the setting: a deployment that already has one gets it
   * back untouched rather than a second database nobody asked for. Writing the
   * setting is part of the same call on purpose -- a database with the right two
   * columns that nothing is configured to read is the state this endpoint
   * exists to prevent.
   */
  async provision(input: {
    userId: string;
    request: ProvisionEntityDatabaseRequest;
    correlationId: string;
  }): Promise<ProvisionEntityDatabaseResponse> {
    const settings = await this.settings.get();
    const configured = settings['entities.databaseId'];
    if (configured !== null) {
      const existing = await this.prisma.document.findFirst({
        where: { id: configured, type: 'COLLECTION', archivedAt: null },
        select: { id: true, workspaceId: true, title: true },
      });
      if (existing !== null) {
        return {
          databaseId: existing.id,
          workspaceId: existing.workspaceId,
          title: existing.title,
          alreadyExisted: true,
        };
      }
    }

    const database = await this.documents.create({
      workspaceId: input.request.workspaceId,
      userId: input.userId,
      request: {
        type: 'COLLECTION',
        title: input.request.title,
        parentId: input.request.parentId ?? undefined,
      },
      correlationId: input.correlationId,
    });

    await this.createSchema(database.id, input.userId, input.correlationId);
    await this.settings.update({
      patch: { 'entities.databaseId': database.id },
      actorId: input.userId,
      workspaceId: input.request.workspaceId,
    });

    this.logger.info('Entity database provisioned', {
      correlationId: input.correlationId,
      documentId: database.id,
      workspaceId: input.request.workspaceId,
    });

    return {
      databaseId: database.id,
      workspaceId: input.request.workspaceId,
      title: database.title,
      alreadyExisted: false,
    };
  }

  /** The two columns the matcher reads, plus one option per known type. */
  private async createSchema(
    databaseId: string,
    userId: string,
    correlationId: string,
  ): Promise<void> {
    const typeProperty = await this.properties.create({
      collectionDocumentId: databaseId,
      userId,
      request: { type: 'SELECT', name: ENTITY_PROPERTY_NAMES.type },
      correlationId,
    });
    for (const type of entityTypeSchema.options) {
      await this.properties.createOption({
        propertyId: typeProperty.id,
        userId,
        request: { label: ENTITY_TYPE_LABELS[type], color: TYPE_COLOURS[type] },
        correlationId,
      });
    }
    await this.properties.create({
      collectionDocumentId: databaseId,
      userId,
      request: { type: 'TEXT', name: ENTITY_PROPERTY_NAMES.aliases },
      correlationId,
    });
  }

  async create(input: {
    userId: string;
    request: CreateEntityRequest;
    correlationId: string;
  }): Promise<EntityMutationResponse> {
    const databaseId = await this.registry.requireDatabaseId();
    const existing = (await this.registry.load()).find(
      (entity) => entityAliasKey(entity.title) === entityAliasKey(input.request.title),
    );
    if (existing !== undefined) {
      throw new AppError(
        'entity_exists',
        `An entity called "${existing.title}" already exists; add a spelling to its aliases instead`,
      );
    }

    const database = await this.prisma.document.findUnique({
      where: { id: databaseId },
      select: { workspaceId: true },
    });
    if (database === null) throw AppError.notFound('Entity database');

    const row = await this.documents.create({
      workspaceId: database.workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title: input.request.title, parentId: databaseId },
      correlationId: input.correlationId,
    });

    await this.writeRowValues({
      databaseId,
      rowId: row.id,
      type: input.request.type,
      aliases: input.request.aliases,
    });

    if (input.request.summary.length > 0) {
      await this.content.write({
        documentId: row.id,
        userId: input.userId,
        request: { markdown: input.request.summary, mode: 'replace' },
        correlationId: input.correlationId,
        source: 'ai',
      });
    }

    await this.enqueueRescan({
      entityDocumentId: row.id,
      userId: input.userId,
      reason: 'created',
      correlationId: input.correlationId,
    });

    return {
      entity: await this.summaryOf(row.id, input.userId),
      rescanQueued: true,
    };
  }

  async update(input: {
    userId: string;
    entityId: string;
    request: UpdateEntityRequest;
    correlationId: string;
  }): Promise<EntityMutationResponse> {
    const databaseId = await this.registry.requireDatabaseId();
    const entity = await this.registry.findReadable(input.userId, input.entityId);
    const context = await this.access.requireDocumentContext(entity.id, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    await this.writeRowValues({
      databaseId,
      rowId: entity.id,
      type: input.request.type,
      aliases: input.request.aliases,
    });

    // Only an alias change needs the old pages looked at again: a type is not
    // something the matcher reads.
    const aliasesChanged = input.request.aliases !== undefined;
    if (aliasesChanged) {
      await this.enqueueRescan({
        entityDocumentId: entity.id,
        userId: input.userId,
        reason: 'aliases_changed',
        correlationId: input.correlationId,
      });
    }

    return {
      entity: await this.summaryOf(entity.id, input.userId),
      rescanQueued: aliasesChanged,
    };
  }

  /**
   * Writes the two columns straight through Prisma.
   *
   * The one place in this service that does not go through the row service, and
   * for a narrow reason: `DatabaseRowsService.updateValues` takes property *ids*
   * from a client that has already read the schema, while everything here works
   * from column names. Resolving the ids and then handing them back to a
   * service that resolves them again buys nothing.
   */
  private async writeRowValues(input: {
    databaseId: string;
    rowId: string;
    type?: EntityType;
    aliases?: readonly string[];
  }): Promise<void> {
    if (input.type !== undefined) {
      const optionId = await this.registry.optionIdForType(input.databaseId, input.type);
      const propertyId = await this.typePropertyId(input.databaseId);
      if (optionId !== null && propertyId !== null) {
        await this.upsertValue(input.rowId, propertyId, optionId);
      }
    }
    if (input.aliases !== undefined) {
      const propertyId = await this.registry.aliasPropertyId(input.databaseId);
      if (propertyId !== null) {
        await this.upsertValue(input.rowId, propertyId, formatEntityAliases(input.aliases));
      }
    }
  }

  private async typePropertyId(databaseId: string): Promise<string | null> {
    const property = await this.prisma.databaseProperty.findFirst({
      where: { documentId: databaseId, name: ENTITY_PROPERTY_NAMES.type },
      select: { id: true },
    });
    return property?.id ?? null;
  }

  private async upsertValue(rowId: string, propertyId: string, value: string): Promise<void> {
    await this.prisma.documentPropertyValue.upsert({
      where: { documentId_propertyId: { documentId: rowId, propertyId } },
      create: { documentId: rowId, propertyId, textValue: value },
      update: { textValue: value },
    });
  }

  /**
   * Draws the edge by hand.
   *
   * `MANUAL` and therefore untouched by every later extraction: a page can be
   * about an entity without naming it, and a matcher will never find that. The
   * caller must be able to read the page, or the edge would be a way to learn
   * that a page exists.
   */
  async linkPage(input: {
    userId: string;
    entityId: string;
    request: LinkEntityPageRequest;
  }): Promise<{ entityId: string; documentId: string; created: boolean }> {
    const entity = await this.registry.findReadable(input.userId, input.entityId);
    const context = await this.access.requireDocumentContext(input.request.documentId, input.userId);

    const existing = await this.prisma.entityMention.findUnique({
      where: {
        entityDocumentId_documentId: {
          entityDocumentId: entity.id,
          documentId: input.request.documentId,
        },
      },
      select: { id: true },
    });

    await this.prisma.entityMention.upsert({
      where: {
        entityDocumentId_documentId: {
          entityDocumentId: entity.id,
          documentId: input.request.documentId,
        },
      },
      create: {
        entityDocumentId: entity.id,
        documentId: input.request.documentId,
        workspaceId: context.workspaceId,
        alias: entity.title,
        aliasKey: entityAliasKey(entity.title),
        occurrences: 1,
        context: input.request.note,
        source: 'MANUAL',
      },
      update: {
        source: 'MANUAL',
        ...(input.request.note.length === 0 ? {} : { context: input.request.note }),
      },
    });

    return {
      entityId: entity.id,
      documentId: input.request.documentId,
      created: existing === null,
    };
  }

  /**
   * Removes the edge.
   *
   * Removes an extracted edge as well as a manual one, and the extracted one
   * will be back after the next save of that page. That is the honest
   * behaviour: the page really does say the name, and pretending otherwise
   * would need a third state nobody asked for.
   */
  async unlinkPage(input: {
    userId: string;
    entityId: string;
    documentId: string;
  }): Promise<{ entityId: string; documentId: string; removed: boolean }> {
    const entity = await this.registry.findReadable(input.userId, input.entityId);
    await this.access.requireDocumentContext(input.documentId, input.userId);

    const result = await this.prisma.entityMention.deleteMany({
      where: { entityDocumentId: entity.id, documentId: input.documentId },
    });
    return { entityId: entity.id, documentId: input.documentId, removed: result.count > 0 };
  }

  async enqueueRescan(input: {
    entityDocumentId: string;
    userId: string;
    reason: 'created' | 'aliases_changed' | 'candidate_confirmed';
    correlationId: string;
  }): Promise<void> {
    await this.queues.enqueue(QUEUE_NAMES.entityRescan, {
      correlationId: input.correlationId,
      entityDocumentId: input.entityDocumentId,
      userId: input.userId,
      reason: input.reason,
    });
  }

  async summaryOf(entityId: string, userId: string): Promise<EntitySummary> {
    const entity = await this.registry.findReadable(userId, entityId);
    const readable = await this.registry.readableWorkspaceIds(userId);
    const counts = await this.registry.mentionCounts([entity.id], readable);
    return this.registry.toSummary(entity, counts.get(entity.id) ?? 0);
  }
}

function matchesNeedle(entity: EntityRecord, needle: string): boolean {
  if (entityAliasKey(entity.title).includes(needle)) return true;
  return entity.aliases.some((alias) => entityAliasKey(alias).includes(needle));
}
