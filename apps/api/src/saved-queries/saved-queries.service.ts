import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageSavedQueries, WorkspaceAccessService } from '@exocortex/auth';
import {
  type CreateSavedQueryRequest,
  DEFAULT_SAVED_QUERY_DISPLAY,
  type DeleteSavedQueryResponse,
  type DocumentPathEntry,
  type ReorderSavedQueryRequest,
  type SavedQuery,
  type SavedQueryDefinition,
  savedQueryDefinitionSchema,
  type SavedQueryDisplay,
  savedQueryDisplaySchema,
  type SavedQueryListResponse,
  type SavedQueryResponse,
  type SavedQueryResultsResponse,
  type UpdateSavedQueryRequest,
} from '@exocortex/contracts';
import {
  collectAncestors,
  compileStructuralFilter,
  generateOrderKey,
  loadDatabaseScope,
  orderKeyAfter,
  Prisma,
  type PrismaClient,
  runSavedQuery,
  type SavedQueryRow,
  SavedQueryScopeError,
  type SearchAdapter,
  UnknownDatabasePropertyError,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';
import { KEYWORD_SEARCH_ADAPTER, SEARCH_ADAPTER } from '../search/search.service';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * The one thing this service is careful about: a saved query is a question,
 * and the answer is computed for whoever is asking, now. Nothing is cached per
 * query, nothing is precomputed, and the membership check happens on the run
 * and not on the save. That is what makes it safe for a query saved by an
 * owner to be run by a guest: the run reads the same tables the guest's own
 * search would.
 */

/**
 * A definition or a display is a hand-written recursive interface (the filter
 * group needs `z.lazy`), so it has no index signature and is not structurally
 * assignable to Prisma's `InputJsonValue`. Both have already been through
 * their zod schema before they reach here, so this is a boundary cast, not an
 * escape hatch. Same reasoning as `database-views.service.ts`.
 */
function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

interface SavedQueryRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  icon: string | null;
  iconColor: string | null;
  definition: unknown;
  display: unknown;
  inSidebar: boolean;
  orderKey: string;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class SavedQueriesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SEARCH_ADAPTER) private readonly hybrid: SearchAdapter,
    @Inject(KEYWORD_SEARCH_ADAPTER) private readonly keyword: SearchAdapter,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(input: { workspaceId: string; userId: string }): Promise<SavedQueryListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);

    const rows = await this.prisma.savedQuery.findMany({
      where: { workspaceId: input.workspaceId },
      // Smart views first, in the order somebody arranged them; everything
      // else alphabetically, because a saved search has no place of its own.
      orderBy: [{ inSidebar: 'desc' }, { orderKey: 'asc' }, { name: 'asc' }],
    });

    return { savedQueries: rows.map((row) => this.toSavedQuery(row)) };
  }

  async get(input: { savedQueryId: string; userId: string }): Promise<SavedQueryResponse> {
    const row = await this.loadReadable(input.savedQueryId, input.userId);
    return { savedQuery: this.toSavedQuery(row) };
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateSavedQueryRequest;
    correlationId: string;
  }): Promise<SavedQueryResponse> {
    const role = await this.access.requireRole(input.workspaceId, input.userId);
    assertPolicy(canManageSavedQueries(role));
    await this.assertRunnable(input.workspaceId, input.request.definition);

    const row = await this.prisma.savedQuery.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.request.name,
        description: input.request.description ?? null,
        icon: input.request.icon ?? null,
        iconColor: input.request.iconColor ?? null,
        definition: toJsonInput(input.request.definition),
        display: toJsonInput(input.request.display ?? DEFAULT_SAVED_QUERY_DISPLAY),
        inSidebar: input.request.inSidebar ?? false,
        orderKey: await this.nextOrderKey(input.workspaceId),
        createdById: input.userId,
        updatedById: input.userId,
      },
    });

    await this.announce(row.workspaceId, row.id, 'created', input.correlationId);
    return { savedQuery: this.toSavedQuery(row) };
  }

  async update(input: {
    savedQueryId: string;
    userId: string;
    request: UpdateSavedQueryRequest;
    correlationId: string;
  }): Promise<SavedQueryResponse> {
    const existing = await this.loadWritable(input.savedQueryId, input.userId);
    if (input.request.definition !== undefined) {
      await this.assertRunnable(existing.workspaceId, input.request.definition);
    }

    const row = await this.prisma.savedQuery.update({
      where: { id: input.savedQueryId },
      data: {
        ...(input.request.name === undefined ? {} : { name: input.request.name }),
        ...(input.request.description === undefined
          ? {}
          : { description: input.request.description }),
        ...(input.request.icon === undefined ? {} : { icon: input.request.icon }),
        ...(input.request.iconColor === undefined ? {} : { iconColor: input.request.iconColor }),
        ...(input.request.definition === undefined
          ? {}
          : { definition: toJsonInput(input.request.definition) }),
        ...(input.request.display === undefined
          ? {}
          : { display: toJsonInput(input.request.display) }),
        ...(input.request.inSidebar === undefined ? {} : { inSidebar: input.request.inSidebar }),
        updatedById: input.userId,
      },
    });

    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
    return { savedQuery: this.toSavedQuery(row) };
  }

  /**
   * Moving a smart view in the navigation.
   *
   * The caller names the neighbour rather than an index, exactly like the page
   * tree does: an index would be wrong the moment somebody else inserted an
   * entry, and a fractional key lets both writes stand.
   */
  async reorder(input: {
    savedQueryId: string;
    userId: string;
    request: ReorderSavedQueryRequest;
    correlationId: string;
  }): Promise<SavedQueryResponse> {
    const existing = await this.loadWritable(input.savedQueryId, input.userId);

    const neighbours = await this.prisma.savedQuery.findMany({
      where: { workspaceId: existing.workspaceId, id: { not: existing.id } },
      orderBy: { orderKey: 'asc' },
      select: { id: true, orderKey: true },
    });
    const index = neighbours.findIndex(
      (entry) => entry.id === (input.request.afterId ?? input.request.beforeId),
    );
    if (index === -1) throw AppError.notFound('The saved query to move next to');

    const anchor = neighbours[index]?.orderKey ?? null;
    const before =
      input.request.afterId !== undefined ? anchor : (neighbours[index - 1]?.orderKey ?? null);
    const after =
      input.request.afterId !== undefined ? (neighbours[index + 1]?.orderKey ?? null) : anchor;

    const row = await this.prisma.savedQuery.update({
      where: { id: existing.id },
      data: { orderKey: generateOrderKey(before, after), updatedById: input.userId },
    });
    await this.announce(row.workspaceId, row.id, 'updated', input.correlationId);
    return { savedQuery: this.toSavedQuery(row) };
  }

  async remove(input: {
    savedQueryId: string;
    userId: string;
    correlationId: string;
  }): Promise<DeleteSavedQueryResponse> {
    const existing = await this.loadWritable(input.savedQueryId, input.userId);
    await this.prisma.savedQuery.delete({ where: { id: existing.id } });
    await this.announce(existing.workspaceId, existing.id, 'deleted', input.correlationId);
    return { deleted: true };
  }

  /** Answering a stored question. */
  async run(input: {
    savedQueryId: string;
    userId: string;
    limit?: number;
  }): Promise<SavedQueryResultsResponse> {
    const row = await this.loadReadable(input.savedQueryId, input.userId);
    const definition = this.parseDefinition(row.definition);
    const response = await this.execute(row.workspaceId, definition, input.limit);
    return { ...response, savedQueryId: row.id, name: row.name };
  }

  /** Answering a question nobody has saved yet, which is what the search area does. */
  async preview(input: {
    workspaceId: string;
    userId: string;
    definition: SavedQueryDefinition;
  }): Promise<SavedQueryResultsResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);
    const response = await this.execute(input.workspaceId, input.definition);
    return { ...response, savedQueryId: null, name: null };
  }

  private async execute(
    workspaceId: string,
    definition: SavedQueryDefinition,
    limit?: number,
  ): Promise<Omit<SavedQueryResultsResponse, 'savedQueryId' | 'name'>> {
    const startedAt = Date.now();
    const scope =
      definition.propertyFilter === null || definition.collectionId === null
        ? undefined
        : await loadDatabaseScope(this.prisma, definition.collectionId);

    let result;
    try {
      result = await runSavedQuery(
        { prisma: this.prisma, hybrid: this.hybrid, keyword: this.keyword, scope },
        { workspaceId, definition, limit },
      );
    } catch (error) {
      // A property the filter names is gone, or the database it belonged to
      // is. Both mean the stored question no longer fits the data and has to
      // be edited; neither is an internal failure.
      if (error instanceof UnknownDatabasePropertyError || error instanceof SavedQueryScopeError) {
        throw new AppError('saved_query_invalid', error.message);
      }
      throw error;
    }

    const paths = await this.resolvePaths(
      workspaceId,
      result.rows.map((row) => row.documentId),
    );

    return {
      definition,
      results: result.rows.map((row) => toHit(row, paths.get(row.documentId) ?? [])),
      truncated: result.truncated,
      adapter: result.adapter,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Refuses a definition that could never be answered, at the moment it is
   * written rather than every time it is read.
   *
   * Only the two things a later read cannot recover from: a database that is
   * not in this workspace, and a property filter whose ids the database does
   * not know. Everything else about a definition can stop matching without
   * becoming an error, which is the correct behaviour for a question.
   */
  private async assertRunnable(
    workspaceId: string,
    definition: SavedQueryDefinition,
  ): Promise<void> {
    for (const documentId of [definition.underDocumentId, definition.collectionId]) {
      if (documentId === null) continue;
      const document = await this.prisma.document.findFirst({
        where: { id: documentId, workspaceId },
        select: { id: true },
      });
      if (document === null) {
        throw new AppError(
          'saved_query_invalid',
          'The query names a page that is not in this workspace',
        );
      }
    }

    if (definition.propertyFilter === null || definition.collectionId === null) return;
    const scope = await loadDatabaseScope(this.prisma, definition.collectionId);
    try {
      // Compiled, not run: whether the filter has meaning is a question about
      // the schema, and asking it costs one schema read rather than a search.
      compileStructuralFilter({ workspaceId, definition }, scope);
    } catch (error) {
      if (error instanceof UnknownDatabasePropertyError || error instanceof SavedQueryScopeError) {
        throw new AppError('saved_query_invalid', error.message);
      }
      throw error;
    }
  }

  private async loadReadable(savedQueryId: string, userId: string): Promise<SavedQueryRecord> {
    const row = await this.prisma.savedQuery.findUnique({ where: { id: savedQueryId } });
    if (row === null) throw AppError.notFound('The saved query');
    await this.access.requireRole(row.workspaceId, userId);
    return row;
  }

  private async loadWritable(savedQueryId: string, userId: string): Promise<SavedQueryRecord> {
    const row = await this.prisma.savedQuery.findUnique({ where: { id: savedQueryId } });
    if (row === null) throw AppError.notFound('The saved query');
    const role = await this.access.requireRole(row.workspaceId, userId);
    assertPolicy(canManageSavedQueries(role));
    return row;
  }

  private async nextOrderKey(workspaceId: string): Promise<string> {
    const last = await this.prisma.savedQuery.findFirst({
      where: { workspaceId },
      orderBy: { orderKey: 'desc' },
      select: { orderKey: true },
    });
    return orderKeyAfter(last?.orderKey ?? null);
  }

  private async announce(
    workspaceId: string,
    savedQueryId: string,
    action: 'created' | 'updated' | 'deleted',
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('saved-query.changed', workspaceId, correlationId, {
      savedQueryId,
      action,
    });
  }

  /**
   * The stored JSON, validated on every read.
   *
   * A definition written by an older build may no longer parse. Saying so is
   * better than silently dropping the field that stopped fitting, because a
   * query that quietly loses its filter answers with far more than it should.
   */
  private parseDefinition(value: unknown): SavedQueryDefinition {
    const parsed = savedQueryDefinitionSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('saved_query_invalid', 'The stored query definition is not valid');
    }
    return parsed.data;
  }

  private parseDisplay(value: unknown): SavedQueryDisplay {
    const parsed = savedQueryDisplaySchema.safeParse(value);
    return parsed.success ? parsed.data : DEFAULT_SAVED_QUERY_DISPLAY;
  }

  private toSavedQuery(row: SavedQueryRecord): SavedQuery {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description,
      icon: row.icon,
      iconColor: row.iconColor as SavedQuery['iconColor'],
      definition: this.parseDefinition(row.definition),
      display: this.parseDisplay(row.display),
      inSidebar: row.inSidebar,
      orderKey: row.orderKey,
      createdById: row.createdById,
      updatedById: row.updatedById,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * The ancestor chain of every hit, root first. One flat read of the
   * workspace's parent links rather than a query per hit, the same way
   * `SearchService` does it and for the same reason.
   */
  private async resolvePaths(
    workspaceId: string,
    documentIds: readonly string[],
  ): Promise<Map<string, DocumentPathEntry[]>> {
    const paths = new Map<string, DocumentPathEntry[]>();
    if (documentIds.length === 0) return paths;

    const rows = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, title: true },
    });
    for (const documentId of documentIds) {
      paths.set(
        documentId,
        collectAncestors(rows, documentId).map((row) => ({ id: row.id, title: row.title })),
      );
    }
    return paths;
  }
}

function toHit(row: SavedQueryRow, path: DocumentPathEntry[]) {
  return {
    documentId: row.documentId,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    title: row.title,
    icon: row.icon,
    iconColor: row.iconColor as SavedQuery['iconColor'],
    type: row.type,
    path,
    snippet: row.snippet,
    rank: row.rank,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
