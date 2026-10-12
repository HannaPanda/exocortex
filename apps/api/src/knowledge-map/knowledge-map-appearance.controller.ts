import { Body, Controller, Delete, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type KnowledgeMapAppearancePatch,
  knowledgeMapAppearancePatchSchema,
  type KnowledgeMapAppearanceResponse,
  knowledgeMapAppearanceResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { KnowledgeMapAppearanceService } from './knowledge-map-appearance.service';

/**
 * The knowledge map's look for the signed-in person (issue #189). `PATCH`
 * changes only what the body names, `DELETE` goes back to the defaults.
 */
@ApiTags('me')
@Controller('api/me/knowledge-map-appearance')
export class KnowledgeMapAppearanceController {
  constructor(private readonly appearance: KnowledgeMapAppearanceService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(knowledgeMapAppearanceResponseSchema) })
  async get(@CurrentSession() session: VerifiedSession): Promise<KnowledgeMapAppearanceResponse> {
    return this.appearance.get(session.userId);
  }

  @Patch()
  @ApiBody({ schema: openApiSchema(knowledgeMapAppearancePatchSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(knowledgeMapAppearanceResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(knowledgeMapAppearancePatchSchema)) body: KnowledgeMapAppearancePatch,
  ): Promise<KnowledgeMapAppearanceResponse> {
    return this.appearance.update(session.userId, body);
  }

  @Delete()
  @ApiOkResponse({ schema: openApiResponseSchema(knowledgeMapAppearanceResponseSchema) })
  async reset(@CurrentSession() session: VerifiedSession): Promise<KnowledgeMapAppearanceResponse> {
    return this.appearance.reset(session.userId);
  }
}
