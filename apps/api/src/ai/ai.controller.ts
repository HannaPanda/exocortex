import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AiRun,
  type AiRunInspection,
  aiRunInspectionSchema,
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
import { RunInspectionService } from './run-inspection.service';

@ApiTags('ai')
@Controller('api/ai/runs')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly inspection: RunInspectionService,
  ) {}

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

  /**
   * What the run did and what its prompt was made of (issue #145, ADR-073):
   * a timeline of sizes, names and outcomes, never a prompt or an answer.
   */
  @Get(':runId/inspection')
  @ApiOkResponse({ schema: openApiResponseSchema(aiRunInspectionSchema) })
  async inspect(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<AiRunInspection> {
    return this.inspection.inspect(runId, session.userId, headers);
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
