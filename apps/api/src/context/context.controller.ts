import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type ContextCompileRequest,
  contextCompileRequestSchema,
  type ContextCompileResponse,
  contextCompileResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, zodPipe } from '../common/zod';

import { ContextService } from './context.service';

/**
 * A GET, because compiling context changes nothing: a token that may only read
 * may ask for it (`requiredScopeForRequest` keys on the method). Not under a
 * workspace, because the answer can span several.
 */
@ApiTags('context')
@Controller('api/context')
export class ContextController {
  constructor(private readonly context: ContextService) {}

  @Get()
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'workspaceIds', required: false, description: 'Comma-separated' })
  @ApiQuery({ name: 'maxChars', required: false })
  @ApiQuery({ name: 'maxSources', required: false })
  @ApiQuery({ name: 'perSourceMaxChars', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(contextCompileResponseSchema) })
  async compile(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(contextCompileRequestSchema)) query: ContextCompileRequest,
  ): Promise<ContextCompileResponse> {
    return this.context.compile(session.userId, query);
  }
}
