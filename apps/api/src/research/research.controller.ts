import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type WebFetchRequest,
  webFetchRequestSchema,
  type WebFetchResponse,
  webFetchResponseSchema,
  type WebSearchRequest,
  webSearchRequestSchema,
  type WebSearchResponse,
  webSearchResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { ResearchService } from './research.service';

/**
 * Web research (issue #26), scoped to a workspace because the switch that
 * allows it is (`ai.webResearchEnabled`, ADR-023).
 *
 * `POST` for both, including the search: the query goes in a body rather than
 * a query string so it never lands in an access log, and a search that reaches
 * out to a dozen engines is not a request anything should be replaying from a
 * cache.
 */
@ApiTags('research')
@Controller('api/workspaces/:workspaceId/research')
export class ResearchController {
  constructor(private readonly research: ResearchService) {}

  @Post('search')
  @ApiOkResponse({ schema: openApiResponseSchema(webSearchResponseSchema) })
  async search(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(webSearchRequestSchema)) request: WebSearchRequest,
  ): Promise<WebSearchResponse> {
    return this.research.search({ workspaceId, userId: session.userId, request });
  }

  @Post('fetch')
  @ApiOkResponse({ schema: openApiResponseSchema(webFetchResponseSchema) })
  async fetch(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(webFetchRequestSchema)) request: WebFetchRequest,
  ): Promise<WebFetchResponse> {
    return this.research.fetch({ workspaceId, userId: session.userId, request });
  }
}
