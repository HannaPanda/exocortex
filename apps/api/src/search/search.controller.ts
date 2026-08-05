import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type SearchRequest,
  searchRequestSchema,
  type SearchResponse,
  searchResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { SearchService } from './search.service';

@ApiTags('search')
@Controller('api/workspaces/:workspaceId/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'includeArchived', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(searchResponseSchema) })
  async search_(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(searchRequestSchema)) query: SearchRequest,
  ): Promise<SearchResponse> {
    return this.search.search(workspaceId, session.userId, query);
  }
}
