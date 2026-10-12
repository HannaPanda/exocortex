import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type KnowledgeMapQuery,
  knowledgeMapQuerySchema,
  type KnowledgeMapResponse,
  knowledgeMapResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { KnowledgeMapService } from './knowledge-map.service';

/** The knowledge map of a workspace (issue #189). */
@ApiTags('workspaces')
@Controller('api/workspaces')
export class KnowledgeMapController {
  constructor(private readonly map: KnowledgeMapService) {}

  /** Every page as a point and every connection between two pages as a line. */
  @Get(':workspaceId/map')
  @ApiOkResponse({ schema: openApiResponseSchema(knowledgeMapResponseSchema) })
  async mapOf(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(knowledgeMapQuerySchema)) query: KnowledgeMapQuery,
  ): Promise<KnowledgeMapResponse> {
    return this.map.get(workspaceId, session.userId, query.exclude);
  }
}
