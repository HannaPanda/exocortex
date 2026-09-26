import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AddWorkItemNoteRequest,
  addWorkItemNoteRequestSchema,
  type CreateWorkItemRequest,
  createWorkItemRequestSchema,
  type DeleteWorkItemResponse,
  deleteWorkItemResponseSchema,
  type ListWorkItemsQuery,
  listWorkItemsQuerySchema,
  type StartWorkItemRunRequest,
  startWorkItemRunRequestSchema,
  type StartWorkItemRunResponse,
  startWorkItemRunResponseSchema,
  type UpdateWorkItemRequest,
  updateWorkItemRequestSchema,
  type WorkItemListResponse,
  workItemListResponseSchema,
  type WorkItemResponse,
  workItemResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { workItemActorOf } from './work-item-actor';
import { WorkItemsService } from './work-items.service';

/**
 * Delegated work (issue #138, ADR-066).
 *
 * The list and creation hang under the workspace; everything else addresses
 * one item by its id. A note and a run are sub-resources rather than fields of
 * the PATCH, because both are events with a life of their own -- a note is
 * never edited, and a run is a job in the queue.
 */
@ApiTags('work-items')
@Controller('api')
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  @Get('workspaces/:workspaceId/work-items')
  @ApiQuery({ name: 'status', required: false, isArray: true })
  @ApiQuery({ name: 'assignee', required: false })
  @ApiQuery({ name: 'requester', required: false })
  @ApiQuery({ name: 'parentId', required: false })
  @ApiQuery({ name: 'open', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(workItemListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listWorkItemsQuerySchema)) query: ListWorkItemsQuery,
  ): Promise<WorkItemListResponse> {
    return this.workItems.list({ workspaceId, userId: session.userId, query });
  }

  @Post('workspaces/:workspaceId/work-items')
  @ApiBody({ schema: openApiSchema(createWorkItemRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(workItemResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createWorkItemRequestSchema)) body: CreateWorkItemRequest,
  ): Promise<WorkItemResponse> {
    return this.workItems.create({
      workspaceId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('work-items/:workItemId')
  @ApiOkResponse({ schema: openApiResponseSchema(workItemResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemResponse> {
    return this.workItems.get({ workItemId, userId: session.userId });
  }

  @Patch('work-items/:workItemId')
  @ApiBody({ schema: openApiSchema(updateWorkItemRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(workItemResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
    @Body(zodPipe(updateWorkItemRequestSchema)) body: UpdateWorkItemRequest,
  ): Promise<WorkItemResponse> {
    return this.workItems.update({
      workItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('work-items/:workItemId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteWorkItemResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
  ): Promise<DeleteWorkItemResponse> {
    return this.workItems.remove({
      workItemId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
      actor: workItemActorOf(session),
    });
  }

  @Post('work-items/:workItemId/notes')
  @ApiBody({ schema: openApiSchema(addWorkItemNoteRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(workItemResponseSchema) })
  async addNote(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
    @Body(zodPipe(addWorkItemNoteRequestSchema)) body: AddWorkItemNoteRequest,
  ): Promise<WorkItemResponse> {
    return this.workItems.addNote({
      workItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('work-items/:workItemId/runs')
  @ApiBody({ schema: openApiSchema(startWorkItemRunRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(startWorkItemRunResponseSchema) })
  async startRun(
    @CurrentSession() session: VerifiedSession,
    @Param('workItemId') workItemId: string,
    @Body(zodPipe(startWorkItemRunRequestSchema)) body: StartWorkItemRunRequest,
  ): Promise<StartWorkItemRunResponse> {
    return this.workItems.startRun({
      workItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
