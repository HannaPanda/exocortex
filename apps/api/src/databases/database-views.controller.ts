import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateDatabaseViewRequest,
  createDatabaseViewRequestSchema,
  type DatabaseView,
  databaseViewSchema,
  type ReorderDatabaseViewRequest,
  reorderDatabaseViewRequestSchema,
  type UpdateDatabaseViewRequest,
  updateDatabaseViewRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DatabaseViewsService } from './database-views.service';

/** View routes, scoped to the collection document (`api/documents/:documentId/views`). */
@ApiTags('databases')
@Controller('api/documents/:documentId/views')
export class DatabaseViewsController {
  constructor(private readonly views: DatabaseViewsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(databaseViewSchema.array()) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<{ views: DatabaseView[] }> {
    return { views: await this.views.list(documentId, session.userId) };
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createDatabaseViewRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(databaseViewSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createDatabaseViewRequestSchema)) body: CreateDatabaseViewRequest,
  ): Promise<DatabaseView> {
    return this.views.create({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Patch(':viewId')
  @ApiBody({ schema: openApiSchema(updateDatabaseViewRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databaseViewSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('viewId') viewId: string,
    @Body(zodPipe(updateDatabaseViewRequestSchema)) body: UpdateDatabaseViewRequest,
  ): Promise<DatabaseView> {
    return this.views.update({
      viewId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':viewId/reorder')
  @ApiBody({ schema: openApiSchema(reorderDatabaseViewRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databaseViewSchema) })
  async reorder(
    @CurrentSession() session: VerifiedSession,
    @Param('viewId') viewId: string,
    @Body(zodPipe(reorderDatabaseViewRequestSchema)) body: ReorderDatabaseViewRequest,
  ): Promise<DatabaseView> {
    return this.views.reorder({
      viewId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete(':viewId')
  @ApiOkResponse({ description: 'View deleted' })
  async delete(
    @CurrentSession() session: VerifiedSession,
    @Param('viewId') viewId: string,
  ): Promise<{ deleted: true }> {
    return this.views.delete({
      viewId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
