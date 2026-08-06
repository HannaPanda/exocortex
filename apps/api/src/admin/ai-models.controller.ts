import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AiModel,
  type AiModelListResponse,
  aiModelListResponseSchema,
  aiModelSchema,
  type CreateAiModelRequest,
  createAiModelRequestSchema,
  type SyncAiModelsRequest,
  syncAiModelsRequestSchema,
  type SyncAiModelsResponse,
  syncAiModelsResponseSchema,
  type UpdateAiModelRequest,
  updateAiModelRequestSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AiModelsService } from './ai-models.service';

const removeResponseSchema = z.object({ deleted: z.boolean(), disabled: z.boolean() });
type RemoveResponse = z.infer<typeof removeResponseSchema>;

/** Admin CRUD and OpenRouter sync for the AI model registry. `@AdminOnly()` on the class. */
@ApiTags('admin')
@AdminOnly()
@Controller('api/admin/ai-models')
export class AdminAiModelsController {
  constructor(private readonly aiModels: AiModelsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(aiModelListResponseSchema) })
  async list(): Promise<AiModelListResponse> {
    return this.aiModels.list();
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createAiModelRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(aiModelSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createAiModelRequestSchema)) body: CreateAiModelRequest,
  ): Promise<AiModel> {
    return this.aiModels.create(body, session.userId);
  }

  @Patch(':modelId')
  @ApiBody({ schema: openApiSchema(updateAiModelRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(aiModelSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('modelId') modelId: string,
    @Body(zodPipe(updateAiModelRequestSchema)) body: UpdateAiModelRequest,
  ): Promise<AiModel> {
    return this.aiModels.update(modelId, body, session.userId);
  }

  @Delete(':modelId')
  @ApiOkResponse({ schema: openApiResponseSchema(removeResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('modelId') modelId: string,
  ): Promise<RemoveResponse> {
    return this.aiModels.remove(modelId, session.userId);
  }

  @Post('sync')
  @ApiBody({ schema: openApiSchema(syncAiModelsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(syncAiModelsResponseSchema) })
  async sync(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(syncAiModelsRequestSchema)) body: SyncAiModelsRequest,
  ): Promise<SyncAiModelsResponse> {
    return this.aiModels.sync(body, session.userId);
  }
}
