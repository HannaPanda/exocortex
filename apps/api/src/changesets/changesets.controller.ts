import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AddChangesetChangeResponse,
  addChangesetChangeResponseSchema,
  type ChangesetDecisionResponse,
  changesetDecisionResponseSchema,
  type ChangesetListResponse,
  changesetListResponseSchema,
  type ChangesetResponse,
  changesetResponseSchema,
  type CreateChangesetRequest,
  createChangesetRequestSchema,
  type DecideChangesetRequest,
  decideChangesetRequestSchema,
  type ListChangesetsQuery,
  listChangesetsQuerySchema,
  type ProposeChange,
  proposeChangeSchema,
  type SubmitChangesetRequest,
  submitChangesetRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';
import { workItemActorOf } from '../work-items/work-item-actor';

import { ChangesetsService } from './changesets.service';

/**
 * Proposed changes (issue #141, ADR-070).
 *
 * Proposing (a draft, its changes, handing it in, throwing a draft away) is
 * one class of route and deciding (apply, reject) another: a credential that
 * may propose may not decide, which `requiredScopeForRequest` reads off the
 * path, so the two verbs are sub-resources rather than a status in a PATCH.
 */
@ApiTags('changesets')
@Controller('api')
export class ChangesetsController {
  constructor(private readonly changesets: ChangesetsService) {}

  @Get('workspaces/:workspaceId/changesets')
  @ApiQuery({ name: 'state', required: false })
  @ApiQuery({ name: 'workItemId', required: false })
  @ApiQuery({ name: 'proposedBy', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(changesetListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(listChangesetsQuerySchema)) query: ListChangesetsQuery,
  ): Promise<ChangesetListResponse> {
    return this.changesets.list({ workspaceId, userId: session.userId, query });
  }

  @Post('workspaces/:workspaceId/changesets')
  @ApiBody({ schema: openApiSchema(createChangesetRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(changesetResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createChangesetRequestSchema)) body: CreateChangesetRequest,
  ): Promise<ChangesetResponse | AddChangesetChangeResponse> {
    return this.changesets.create({
      workspaceId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('changesets/:changesetId')
  @ApiOkResponse({ schema: openApiResponseSchema(changesetResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
  ): Promise<ChangesetResponse> {
    return this.changesets.get({ changesetId, userId: session.userId });
  }

  @Delete('changesets/:changesetId')
  async discard(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
  ): Promise<{ deleted: true }> {
    return this.changesets.discard({
      changesetId,
      actor: workItemActorOf(session),
      correlationId: currentCorrelationId(),
    });
  }

  @Post('changesets/:changesetId/changes')
  @ApiBody({ schema: openApiSchema(proposeChangeSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(addChangesetChangeResponseSchema) })
  async addChange(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
    @Body(zodPipe(proposeChangeSchema)) body: ProposeChange,
  ): Promise<AddChangesetChangeResponse> {
    return this.changesets.addChange({
      changesetId,
      actor: workItemActorOf(session),
      change: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('changesets/:changesetId/changes/:changeId')
  @ApiOkResponse({ schema: openApiResponseSchema(changesetResponseSchema) })
  async removeChange(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
    @Param('changeId') changeId: string,
  ): Promise<ChangesetResponse> {
    return this.changesets.removeChange({
      changesetId,
      changeId,
      actor: workItemActorOf(session),
      correlationId: currentCorrelationId(),
    });
  }

  @Post('changesets/:changesetId/submit')
  @ApiBody({ schema: openApiSchema(submitChangesetRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(changesetResponseSchema) })
  async submit(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
    @Body(zodPipe(submitChangesetRequestSchema)) body: SubmitChangesetRequest,
  ): Promise<ChangesetResponse> {
    return this.changesets.submit({
      changesetId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('changesets/:changesetId/apply')
  @ApiBody({ schema: openApiSchema(decideChangesetRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(changesetDecisionResponseSchema) })
  async apply(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
    @Body(zodPipe(decideChangesetRequestSchema)) body: DecideChangesetRequest,
  ): Promise<ChangesetDecisionResponse> {
    return this.changesets.apply({
      changesetId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('changesets/:changesetId/reject')
  @ApiBody({ schema: openApiSchema(decideChangesetRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(changesetDecisionResponseSchema) })
  async reject(
    @CurrentSession() session: VerifiedSession,
    @Param('changesetId') changesetId: string,
    @Body(zodPipe(decideChangesetRequestSchema)) body: DecideChangesetRequest,
  ): Promise<ChangesetDecisionResponse> {
    return this.changesets.reject({
      changesetId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
