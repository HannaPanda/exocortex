import { Inject, Injectable } from '@nestjs/common';

import { createEmbeddingClient, createEmbeddingProvider } from '@exocortex/ai';
import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type DocumentPathEntry,
  type SearchRequest,
  type SearchResponse,
  semanticSearchOptions,
} from '@exocortex/contracts';
import {
  collectAncestors,
  HybridSearchAdapter,
  PostgresSearchAdapter,
  type PrismaClient,
  type SearchAdapter,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

export const SEARCH_ADAPTER = Symbol('EXOCORTEX_SEARCH_ADAPTER');

/**
 * The full-text half on its own.
 *
 * The search box always wants both halves fused, but a saved query may ask for
 * keyword matching explicitly (issue #74): a question about an exact word does
 * not need a vector, and a list that refreshes on every page view should not
 * pay a model call for one. Provided here rather than built where it is used,
 * so both adapters stay configured in the same place.
 */
export const KEYWORD_SEARCH_ADAPTER = Symbol('EXOCORTEX_KEYWORD_SEARCH_ADAPTER');

/**
 * Search application service.
 *
 * Membership is verified before any query runs, and the workspace filter is part
 * of the SQL, so results can never leak across workspaces.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async search(
    workspaceId: string,
    userId: string,
    request: SearchRequest,
  ): Promise<SearchResponse> {
    await this.access.requireRole(workspaceId, userId);

    const startedAt = Date.now();
    const hits = await this.adapter.search({
      workspaceId,
      query: request.q,
      limit: request.limit,
      includeArchived: request.includeArchived,
    });

    const paths = await this.resolvePaths(
      workspaceId,
      hits.map((hit) => hit.documentId),
    );

    return {
      query: request.q,
      results: hits.map((hit) => ({ ...hit, path: paths.get(hit.documentId) ?? [] })),
      adapter: this.adapter.id,
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * The ancestor chain of every hit, root first.
   *
   * One flat read of the workspace's parent links rather than a query per hit:
   * a chain can be any length, and walking it row by row would be a request
   * per level per result. The rows carry three small columns, so even a large
   * workspace stays a single cheap index scan.
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

export const keywordSearchAdapterProvider = {
  provide: KEYWORD_SEARCH_ADAPTER,
  inject: [PRISMA],
  useFactory: (prisma: PrismaClient): SearchAdapter => new PostgresSearchAdapter(prisma),
};

export const searchAdapterProvider = {
  provide: SEARCH_ADAPTER,
  inject: [PRISMA, API_ENV, LOGGER, SettingsService],
  useFactory: (
    prisma: PrismaClient,
    env: ApiEnv,
    logger: Logger,
    settings: SettingsService,
  ): SearchAdapter =>
    new HybridSearchAdapter({
      prisma,
      keyword: new PostgresSearchAdapter(prisma),
      embeddings: createEmbeddingClient(
        createEmbeddingProvider({
          providerId: env.AI_PROVIDER,
          logger,
          appUrl: env.APP_URL,
          apiKey: env.OPENROUTER_API_KEY ?? '',
          baseUrl: env.OPENROUTER_BASE_URL,
        }),
      ),
      options: async () => semanticSearchOptions(await settings.get()),
      logger,
    }),
};
