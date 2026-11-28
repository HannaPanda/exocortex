import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateDatabaseRowRequest,
  createDatabaseRowRequestSchema,
  type DatabaseRow,
  type DatabaseRowIdsRequest,
  databaseRowIdsRequestSchema,
  databaseRowSchema,
  type DatabaseRowsResponse,
  databaseRowsResponseSchema,
  type DocumentRowResponse,
  documentRowResponseSchema,
  type DuplicateDatabaseRowsResponse,
  duplicateDatabaseRowsResponseSchema,
  type QueryDatabaseRowsRequest,
  queryDatabaseRowsRequestSchema,
  type QueryDatabaseRowsResponse,
  queryDatabaseRowsResponseSchema,
  type TrashDatabaseRowsResponse,
  trashDatabaseRowsResponseSchema,
  type UpdateDatabaseRowsRequest,
  updateDatabaseRowsRequestSchema,
  type UpdateDatabaseRowValuesRequest,
  updateDatabaseRowValuesRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { DatabaseRowActionsService } from './database-row-actions.service';
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
  constructor(
    private readonly rows: DatabaseRowsService,
    private readonly rowActions: DatabaseRowActionsService,
  ) {}

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
    return this.rows.describeDocumentRow(documentId, session.userId);
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

  /**
   * The same values for several rows of this database (issue #244): one
   * request, every row checked before any is written, all or nothing.
   */
  @Patch(':documentId/rows/values')
  @ApiBody({ schema: openApiSchema(updateDatabaseRowsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(databaseRowsResponseSchema) })
  async updateMany(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(updateDatabaseRowsRequestSchema)) body: UpdateDatabaseRowsRequest,
  ): Promise<DatabaseRowsResponse> {
    return this.rows.updateMany({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /** Puts several rows of this database in the trash, each restorable on its own. */
  @Post(':documentId/rows/trash')
  @ApiBody({ schema: openApiSchema(databaseRowIdsRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(trashDatabaseRowsResponseSchema) })
  async trash(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(databaseRowIdsRequestSchema)) body: DatabaseRowIdsRequest,
  ): Promise<TrashDatabaseRowsResponse> {
    return this.rowActions.trash({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /** A copy of each named row, directly below it. */
  @Post(':documentId/rows/duplicate')
  @ApiBody({ schema: openApiSchema(databaseRowIdsRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(duplicateDatabaseRowsResponseSchema) })
  async duplicate(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(databaseRowIdsRequestSchema)) body: DatabaseRowIdsRequest,
  ): Promise<DuplicateDatabaseRowsResponse> {
    return this.rowActions.duplicate({
      collectionDocumentId: documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
