import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AiFillCellResultRequest,
  aiFillCellResultRequestSchema,
  type AiFillCellResultResponse,
  aiFillCellResultResponseSchema,
  type AiFillMaterial,
  aiFillMaterialSchema,
  type AiFillRun,
  type AiFillRunDetail,
  aiFillRunDetailSchema,
  type AiFillRunListResponse,
  aiFillRunListResponseSchema,
  aiFillRunSchema,
  type AiFillStartResponse,
  aiFillStartResponseSchema,
  type DatabaseProperty,
  databasePropertySchema,
  type SetDatabasePropertyAiRequest,
  setDatabasePropertyAiRequestSchema,
  type StartAiFillRequest,
  startAiFillRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../../auth/session.guard';
import { currentCorrelationId } from '../../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../../common/zod';

import { AiFillService } from './ai-fill.service';
import { AiFillConfigService } from './ai-fill-config.service';
import { AiFillWorkerService } from './ai-fill-worker.service';

const listQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
type ListQuery = z.output<typeof listQuerySchema>;

/**
 * A column's AI instruction and the batches that fill it (issue #237,
 * ADR-099). The instruction hangs on the property; a batch on the database it
 * fills, and is then addressed by its own id like any AI run.
 */
@ApiTags('databases')
@Controller('api')
export class AiFillController {
  constructor(
    private readonly config: AiFillConfigService,
    private readonly fills: AiFillService,
    private readonly worker: AiFillWorkerService,
  ) {}

  @Patch('documents/:documentId/properties/:propertyId/ai')
  @ApiBody({ schema: openApiSchema(setDatabasePropertyAiRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertySchema) })
  async setInstruction(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Param('propertyId') propertyId: string,
    @Body(zodPipe(setDatabasePropertyAiRequestSchema)) body: SetDatabasePropertyAiRequest,
  ): Promise<DatabaseProperty> {
    return this.config.set({
      collectionDocumentId: documentId,
      propertyId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('documents/:documentId/properties/:propertyId/ai')
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertySchema) })
  async removeInstruction(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Param('propertyId') propertyId: string,
  ): Promise<DatabaseProperty> {
    return this.config.remove({
      collectionDocumentId: documentId,
      propertyId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('documents/:documentId/ai-fills')
  @ApiBody({ schema: openApiSchema(startAiFillRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillStartResponseSchema) })
  async start(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(startAiFillRequestSchema)) body: StartAiFillRequest,
  ): Promise<AiFillStartResponse> {
    return this.fills.start({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('documents/:documentId/ai-fills')
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillRunListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Query(zodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<AiFillRunListResponse> {
    return {
      runs: await this.fills.list({
        collectionDocumentId: documentId,
        userId: session.userId,
        active: query.active,
      }),
    };
  }

  @Get('ai-fills/:runId')
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillRunDetailSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
  ): Promise<AiFillRunDetail> {
    return this.fills.get(runId, session.userId);
  }

  @Post('ai-fills/:runId/cancel')
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillRunSchema) })
  async cancel(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
  ): Promise<AiFillRun> {
    return this.fills.cancel(runId, session.userId, currentCorrelationId());
  }

  @Post('ai-fills/:runId/retry')
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillStartResponseSchema) })
  async retry(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
  ): Promise<AiFillStartResponse> {
    return this.fills.retry(runId, session.userId, currentCorrelationId());
  }

  /** The worker's: what the model may read for one cell. */
  @Get('ai-fills/:runId/cells/:cellId/material')
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillMaterialSchema) })
  async material(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Param('cellId') cellId: string,
  ): Promise<AiFillMaterial> {
    return this.worker.material(runId, cellId, session.userId);
  }

  /** The worker's: the model's answer for one cell. */
  @Post('ai-fills/:runId/cells/:cellId/result')
  @ApiBody({ schema: openApiSchema(aiFillCellResultRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(aiFillCellResultResponseSchema) })
  async result(
    @CurrentSession() session: VerifiedSession,
    @Param('runId') runId: string,
    @Param('cellId') cellId: string,
    @Body(zodPipe(aiFillCellResultRequestSchema)) body: AiFillCellResultRequest,
  ): Promise<AiFillCellResultResponse> {
    return this.worker.result(runId, cellId, session.userId, body);
  }
}
