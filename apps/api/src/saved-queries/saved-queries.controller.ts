import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateSavedQueryRequest,
  createSavedQueryRequestSchema,
  type DeleteSavedQueryResponse,
  deleteSavedQueryResponseSchema,
  type PreviewSavedQueryRequest,
  previewSavedQueryRequestSchema,
  type ReorderSavedQueryRequest,
  reorderSavedQueryRequestSchema,
  type RunSavedQueryRequest,
  runSavedQueryRequestSchema,
  type SavedQueryListResponse,
  savedQueryListResponseSchema,
  type SavedQueryResponse,
  savedQueryResponseSchema,
  type SavedQueryResultsResponse,
  savedQueryResultsResponseSchema,
  type UpdateSavedQueryRequest,
  updateSavedQueryRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { SavedQueriesService } from './saved-queries.service';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * The listing and the preview hang under the workspace, because "which
 * questions are stored here" and "answer this question" are questions about a
 * workspace. Everything else addresses one saved query by its id.
 *
 * `GET .../results` rather than `POST .../run`: running a saved query changes
 * nothing, and a GET is what lets a query block be re-read on every page view
 * without a browser warning about resubmission.
 */
@ApiTags('saved-queries')
@Controller('api')
export class SavedQueriesController {
  constructor(private readonly savedQueries: SavedQueriesService) {}

  @Get('workspaces/:workspaceId/saved-queries')
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<SavedQueryListResponse> {
    return this.savedQueries.list({ workspaceId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/saved-queries')
  @ApiBody({ schema: openApiSchema(createSavedQueryRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(savedQueryResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createSavedQueryRequestSchema)) body: CreateSavedQueryRequest,
  ): Promise<SavedQueryResponse> {
    return this.savedQueries.create({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('workspaces/:workspaceId/saved-queries/preview')
  @ApiBody({ schema: openApiSchema(previewSavedQueryRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryResultsResponseSchema) })
  async preview(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(previewSavedQueryRequestSchema)) body: PreviewSavedQueryRequest,
  ): Promise<SavedQueryResultsResponse> {
    return this.savedQueries.preview({
      workspaceId,
      userId: session.userId,
      definition: body.definition,
    });
  }

  @Get('saved-queries/:savedQueryId')
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('savedQueryId') savedQueryId: string,
  ): Promise<SavedQueryResponse> {
    return this.savedQueries.get({ savedQueryId, userId: session.userId });
  }

  @Patch('saved-queries/:savedQueryId')
  @ApiBody({ schema: openApiSchema(updateSavedQueryRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('savedQueryId') savedQueryId: string,
    @Body(zodPipe(updateSavedQueryRequestSchema)) body: UpdateSavedQueryRequest,
  ): Promise<SavedQueryResponse> {
    return this.savedQueries.update({
      savedQueryId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('saved-queries/:savedQueryId/position')
  @ApiBody({ schema: openApiSchema(reorderSavedQueryRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryResponseSchema) })
  async reorder(
    @CurrentSession() session: VerifiedSession,
    @Param('savedQueryId') savedQueryId: string,
    @Body(zodPipe(reorderSavedQueryRequestSchema)) body: ReorderSavedQueryRequest,
  ): Promise<SavedQueryResponse> {
    return this.savedQueries.reorder({
      savedQueryId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('saved-queries/:savedQueryId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteSavedQueryResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('savedQueryId') savedQueryId: string,
  ): Promise<DeleteSavedQueryResponse> {
    return this.savedQueries.remove({
      savedQueryId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('saved-queries/:savedQueryId/results')
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(savedQueryResultsResponseSchema) })
  async results(
    @CurrentSession() session: VerifiedSession,
    @Param('savedQueryId') savedQueryId: string,
    @Query(zodPipe(runSavedQueryRequestSchema)) query: RunSavedQueryRequest,
  ): Promise<SavedQueryResultsResponse> {
    return this.savedQueries.run({ savedQueryId, userId: session.userId, limit: query.limit });
  }
}
