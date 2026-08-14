import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateDatabaseRowRequest,
  createDatabaseRowRequestSchema,
  type DatabaseRow,
  databaseRowSchema,
  type DocumentRowResponse,
  documentRowResponseSchema,
  type QueryDatabaseRowsRequest,
  queryDatabaseRowsRequestSchema,
  type QueryDatabaseRowsResponse,
  queryDatabaseRowsResponseSchema,
  type UpdateDatabaseRowValuesRequest,
  updateDatabaseRowValuesRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DatabaseRowsService } from './database-rows.service';

/**
 * Row routes. Querying and creating are scoped to the collection document;
 * writing values is scoped to the row itself, since a row is just a
 * `Document` and its id is all a client needs (see `documents.controller.ts`
 * for the analogous `:documentId/archive` pattern).
 */
@ApiTags('databases')
@Controller('api/documents')
export class DatabaseRowsController {
  constructor(private readonly rows: DatabaseRowsService) {}

  @Post(':documentId/rows/query')
  @ApiBody({ schema: openApiSchema(queryDatabaseRowsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(queryDatabaseRowsResponseSchema) })
  async query(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(queryDatabaseRowsRequestSchema)) body: QueryDatabaseRowsRequest,
  ): Promise<QueryDatabaseRowsResponse> {
    return this.rows.query({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
    });
  }

  @Post(':documentId/rows')
  @ApiBody({ schema: openApiSchema(createDatabaseRowRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(databaseRowSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createDatabaseRowRequestSchema)) body: CreateDatabaseRowRequest,
  ): Promise<DatabaseRow> {
    return this.rows.create({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * Answers "is this document a database row, and if so what are its values?"
   * for the context panel's properties tab (issue #17): the caller has a
   * document id and no reason to already know its collection.
   */
  @Get(':documentId/row')
  @ApiOkResponse({ schema: openApiResponseSchema(documentRowResponseSchema) })
  async getRow(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<DocumentRowResponse> {
    return { row: await this.rows.getForDocument(documentId, session.userId) };
  }

  @Patch(':documentId/values')
  @ApiBody({ schema: openApiSchema(updateDatabaseRowValuesRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databaseRowSchema) })
  async updateValues(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(updateDatabaseRowValuesRequestSchema)) body: UpdateDatabaseRowValuesRequest,
  ): Promise<DatabaseRow> {
    return this.rows.updateValues({
      rowId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
