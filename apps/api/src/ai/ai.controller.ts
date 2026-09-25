import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AiRun,
  aiRunSchema,
  type CreateAiRunRequest,
  createAiRunRequestSchema,
  type CreateAiRunResponse,
  createAiRunResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { type ReaderLocaleHeaders } from '../common/reader-locale';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AiService } from './ai.service';

@ApiTags('ai')
@Controller('api/ai/runs')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post()
  @ApiBody({ schema: openApiSchema(createAiRunRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(createAiRunResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createAiRunRequestSchema)) body: CreateAiRunRequest,
  ): Promise<CreateAiRunResponse> {
    return {
      run: await this.ai.createRun({
        userId: session.userId,
        request: body,
        correlationId: currentCorrelationId(),
      }),
    };
  }

  @Get(':runId')
  @ApiOkResponse({ schema: openApiResponseSchema(aiRunSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<AiRun> {
    return this.ai.getRun(runId, session.userId, headers);
  }

  @Post(':runId/cancel')
  @ApiOkResponse({ schema: openApiResponseSchema(aiRunSchema) })
  async cancel(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
  ): Promise<AiRun> {
    return this.ai.cancelRun(runId, session.userId);
  }
}
