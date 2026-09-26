import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AttentionItemResponse,
  attentionItemResponseSchema,
  type AttentionListResponse,
  attentionListResponseSchema,
  type ListAttentionQuery,
  listAttentionQuerySchema,
  type RequestAttention,
  requestAttentionSchema,
  type ResolveAttention,
  resolveAttentionSchema,
  type WithdrawAttention,
  withdrawAttentionSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';
import { workItemActorOf } from '../work-items/work-item-actor';

import { AttentionService } from './attention.service';

/**
 * What needs a person (issue #139, ADR-067).
 *
 * The list spans the caller's workspaces, because the inbox is one place;
 * asking hangs under the workspace it is asked in. Answering and withdrawing
 * are actions rather than a PATCH: an item moves once, and what moves it is an
 * event with a meaning, not a field somebody edits.
 */
@ApiTags('attention')
@Controller('api')
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get('attention')
  @ApiQuery({ name: 'scope', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'workspaceId', required: false })
  @ApiQuery({ name: 'workItemId', required: false })
  @ApiQuery({ name: 'kind', required: false, isArray: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(attentionListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(listAttentionQuerySchema)) query: ListAttentionQuery,
  ): Promise<AttentionListResponse> {
    return this.attention.list({ userId: session.userId, query });
  }

  @Get('attention/:attentionItemId')
  @ApiOkResponse({ schema: openApiResponseSchema(attentionItemResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('attentionItemId') attentionItemId: string,
  ): Promise<AttentionItemResponse> {
    return this.attention.get({ attentionItemId, userId: session.userId });
  }

  @Post('workspaces/:workspaceId/attention')
  @ApiBody({ schema: openApiSchema(requestAttentionSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(attentionItemResponseSchema) })
  async request(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(requestAttentionSchema)) body: RequestAttention,
  ): Promise<AttentionItemResponse> {
    return this.attention.request({
      workspaceId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('attention/:attentionItemId/resolve')
  @ApiBody({ schema: openApiSchema(resolveAttentionSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(attentionItemResponseSchema) })
  async resolve(
    @CurrentSession() session: VerifiedSession,
    @Param('attentionItemId') attentionItemId: string,
    @Body(zodPipe(resolveAttentionSchema)) body: ResolveAttention,
  ): Promise<AttentionItemResponse> {
    return this.attention.resolve({
      attentionItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('attention/:attentionItemId/withdraw')
  @ApiBody({ schema: openApiSchema(withdrawAttentionSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(attentionItemResponseSchema) })
  async withdraw(
    @CurrentSession() session: VerifiedSession,
    @Param('attentionItemId') attentionItemId: string,
    @Body(zodPipe(withdrawAttentionSchema)) body: WithdrawAttention,
  ): Promise<AttentionItemResponse> {
    return this.attention.withdraw({
      attentionItemId,
      actor: workItemActorOf(session),
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
