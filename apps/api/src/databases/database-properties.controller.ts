import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateDatabasePropertyOptionRequest,
  createDatabasePropertyOptionRequestSchema,
  type CreateDatabasePropertyRequest,
  createDatabasePropertyRequestSchema,
  type DatabaseProperty,
  type DatabasePropertyOption,
  databasePropertyOptionSchema,
  databasePropertySchema,
  type ReorderDatabasePropertyRequest,
  reorderDatabasePropertyRequestSchema,
  type UpdateDatabasePropertyOptionRequest,
  updateDatabasePropertyOptionRequestSchema,
  type UpdateDatabasePropertyRequest,
  updateDatabasePropertyRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DatabasePropertiesService } from './database-properties.service';

/** Property routes, scoped to the collection document (`api/documents/:documentId/properties`). */
@ApiTags('databases')
@Controller('api/documents/:documentId/properties')
export class DatabasePropertiesController {
  constructor(private readonly properties: DatabasePropertiesService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertySchema.array()) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<{ properties: DatabaseProperty[] }> {
    return { properties: await this.properties.list(documentId, session.userId) };
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createDatabasePropertyRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(databasePropertySchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createDatabasePropertyRequestSchema)) body: CreateDatabasePropertyRequest,
  ): Promise<DatabaseProperty> {
    return this.properties.create({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Patch(':propertyId')
  @ApiBody({ schema: openApiSchema(updateDatabasePropertyRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertySchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('propertyId') propertyId: string,
    @Body(zodPipe(updateDatabasePropertyRequestSchema)) body: UpdateDatabasePropertyRequest,
  ): Promise<DatabaseProperty> {
    return this.properties.update({
      propertyId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':propertyId/reorder')
  @ApiBody({ schema: openApiSchema(reorderDatabasePropertyRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertySchema) })
  async reorder(
    @CurrentSession() session: VerifiedSession,
    @Param('propertyId') propertyId: string,
    @Body(zodPipe(reorderDatabasePropertyRequestSchema)) body: ReorderDatabasePropertyRequest,
  ): Promise<DatabaseProperty> {
    return this.properties.reorder({
      propertyId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete(':propertyId')
  @ApiOkResponse({ description: 'Property deleted' })
  async delete(
    @CurrentSession() session: VerifiedSession,
    @Param('propertyId') propertyId: string,
  ): Promise<{ deleted: true }> {
    return this.properties.delete({
      propertyId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':propertyId/options')
  @ApiBody({ schema: openApiSchema(createDatabasePropertyOptionRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(databasePropertyOptionSchema) })
  async createOption(
    @CurrentSession() session: VerifiedSession,
    @Param('propertyId') propertyId: string,
    @Body(zodPipe(createDatabasePropertyOptionRequestSchema)) body: CreateDatabasePropertyOptionRequest,
  ): Promise<DatabasePropertyOption> {
    return this.properties.createOption({
      propertyId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Patch(':propertyId/options/:optionId')
  @ApiBody({ schema: openApiSchema(updateDatabasePropertyOptionRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databasePropertyOptionSchema) })
  async updateOption(
    @CurrentSession() session: VerifiedSession,
    @Param('optionId') optionId: string,
    @Body(zodPipe(updateDatabasePropertyOptionRequestSchema)) body: UpdateDatabasePropertyOptionRequest,
  ): Promise<DatabasePropertyOption> {
    return this.properties.updateOption({
      optionId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete(':propertyId/options/:optionId')
  @ApiOkResponse({ description: 'Option deleted' })
  async deleteOption(
    @CurrentSession() session: VerifiedSession,
    @Param('optionId') optionId: string,
  ): Promise<{ deleted: true }> {
    return this.properties.deleteOption({
      optionId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
