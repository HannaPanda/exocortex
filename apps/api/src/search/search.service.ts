import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type SearchRequest, type SearchResponse } from '@exocortex/contracts';
import { PostgresSearchAdapter, type PrismaClient, type SearchAdapter } from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';

export const SEARCH_ADAPTER = Symbol('EXOCORTEX_SEARCH_ADAPTER');

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
    private readonly access: WorkspaceAccessService,
  ) {}

  async search(
    workspaceId: string,
    userId: string,
    request: SearchRequest,
  ): Promise<SearchResponse> {
    await this.access.requireRole(workspaceId, userId);

    const startedAt = Date.now();
    const results = await this.adapter.search({
      workspaceId,
      query: request.q,
      limit: request.limit,
      includeArchived: request.includeArchived,
    });

    return {
      query: request.q,
      results,
      adapter: this.adapter.id,
      tookMs: Date.now() - startedAt,
    };
  }
}

export const searchAdapterProvider = {
  provide: SEARCH_ADAPTER,
  inject: [PRISMA],
  useFactory: (prisma: PrismaClient): SearchAdapter => new PostgresSearchAdapter(prisma),
};
