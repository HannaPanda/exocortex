import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  ENTITY_PROPERTY_NAMES,
  ENTITY_TYPE_LABELS,
  type EntitySummary,
  type EntityType,
} from '@exocortex/contracts';
import { type EntityRecord, loadEntityRegistry, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

/**
 * Where the entity database is, and who may see what is in it (issue #47).
 *
 * Split out from the endpoints because every one of them starts the same way:
 * find the configured database, refuse politely when there is none, and reduce
 * whatever comes back to the workspaces the caller may read. Repeating that in
 * six methods is how one of them ends up forgetting the last step.
 */
@Injectable()
export class EntityRegistryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly access: WorkspaceAccessService,
  ) {}

  /** The configured database id, or null when the deployment has none. */
  async databaseId(): Promise<string | null> {
    const settings = await this.settings.get();
    if (!settings['entities.enabled']) return null;
    return settings['entities.databaseId'];
  }

  /**
   * The database id, or an error a client can act on.
   *
   * `entity_layer_unavailable` rather than a 404: the caller did nothing wrong,
   * the deployment has not been set up, and the fix is a single admin setting.
   */
  async requireDatabaseId(): Promise<string> {
    const databaseId = await this.databaseId();
    if (databaseId === null) {
      throw new AppError(
        'entity_layer_unavailable',
        'No entity database is configured; set entities.databaseId in the admin settings',
      );
    }
    return databaseId;
  }

  /** Every entity, unfiltered. Callers that answer a person must filter. */
  async load(): Promise<EntityRecord[]> {
    const databaseId = await this.databaseId();
    if (databaseId === null) return [];
    return loadEntityRegistry(this.prisma, databaseId);
  }

  /**
   * The entity rows this user may actually read.
   *
   * One membership check for the whole database rather than per row: every row
   * of a database lives in the database's workspace, so the question has one
   * answer. Kept as a filter anyway, because a caller that may not read the
   * database must get an empty list and not an authorization error -- for an
   * agent, an entity it may not see does not exist.
   */
  async loadReadable(userId: string): Promise<EntityRecord[]> {
    const entities = await this.load();
    const first = entities[0];
    if (first === undefined) return [];
    const role = await this.access.findRole(first.workspaceId, userId);
    return role === null ? [] : entities;
  }

  async findReadable(userId: string, entityId: string): Promise<EntityRecord> {
    const entity = (await this.loadReadable(userId)).find((record) => record.id === entityId);
    if (entity === undefined) throw AppError.notFound('Entity');
    return entity;
  }

  /** Workspace ids the user may read. The filter every mention list runs through. */
  async readableWorkspaceIds(userId: string): Promise<Set<string>> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { archivedAt: null } },
      select: { workspaceId: true },
    });
    return new Set(memberships.map((membership) => membership.workspaceId));
  }

  /** Counts pages per entity, already reduced to what the caller may see. */
  async mentionCounts(
    entityIds: readonly string[],
    readable: ReadonlySet<string>,
  ): Promise<Map<string, number>> {
    if (entityIds.length === 0 || readable.size === 0) return new Map();
    const grouped = await this.prisma.entityMention.groupBy({
      by: ['entityDocumentId'],
      where: {
        entityDocumentId: { in: [...entityIds] },
        workspaceId: { in: [...readable] },
        document: { archivedAt: null },
      },
      _count: { _all: true },
    });
    return new Map(grouped.map((row) => [row.entityDocumentId, row._count._all]));
  }

  toSummary(entity: EntityRecord, mentionCount: number): EntitySummary {
    return {
      id: entity.id,
      workspaceId: entity.workspaceId,
      title: entity.title,
      type: entity.type,
      aliases: entity.aliases,
      mentionCount,
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  /**
   * The id of the SELECT option standing for a type.
   *
   * Null when the database has no such option, and the caller then leaves the
   * column empty rather than failing: the type is a label a person may rename
   * or delete in the browser, and a save that refuses because somebody tidied
   * up a dropdown would be the layer breaking over decoration.
   */
  async optionIdForType(databaseId: string, type: EntityType): Promise<string | null> {
    const property = await this.prisma.databaseProperty.findFirst({
      where: { documentId: databaseId, name: ENTITY_PROPERTY_NAMES.type, type: 'SELECT' },
      select: { id: true, options: { select: { id: true, label: true, orderKey: true } } },
    });
    if (property === null) return null;

    const label = ENTITY_TYPE_LABELS[type];
    const existing = property.options.find(
      (option) => option.label.toLowerCase() === label.toLowerCase(),
    );
    return existing?.id ?? null;
  }

  /** The `Aliasse` column of the database, when it has one. */
  async aliasPropertyId(databaseId: string): Promise<string | null> {
    const property = await this.prisma.databaseProperty.findFirst({
      where: { documentId: databaseId, name: ENTITY_PROPERTY_NAMES.aliases },
      select: { id: true },
    });
    return property?.id ?? null;
  }
}
