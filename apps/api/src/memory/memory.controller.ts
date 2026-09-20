import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AgentMessageListQuery,
  agentMessageListQuerySchema,
  type AgentMessageListResponse,
  agentMessageListResponseSchema,
  type AgentMessageReadRequest,
  agentMessageReadRequestSchema,
  type AgentMessageReadResponse,
  agentMessageReadResponseSchema,
  type AgentMessageSendRequest,
  agentMessageSendRequestSchema,
  type AgentMessageSendResponse,
  agentMessageSendResponseSchema,
  type MemoryCaptureRequest,
  memoryCaptureRequestSchema,
  type MemoryCaptureResponse,
  memoryCaptureResponseSchema,
  type MemoryCheckpointRequest,
  memoryCheckpointRequestSchema,
  type MemoryCheckpointResponse,
  memoryCheckpointResponseSchema,
  type MemoryConsolidateRequest,
  memoryConsolidateRequestSchema,
  type MemoryConsolidateResponse,
  memoryConsolidateResponseSchema,
  type MemoryFactListQuery,
  memoryFactListQuerySchema,
  type MemoryFactListResponse,
  memoryFactListResponseSchema,
  type MemoryFactPromoteRequest,
  memoryFactPromoteRequestSchema,
  type MemoryFactPromoteResponse,
  memoryFactPromoteResponseSchema,
  type MemoryRecallRequest,
  memoryRecallRequestSchema,
  type MemoryRecallResponse,
  memoryRecallResponseSchema,
  type MemoryRememberRequest,
  memoryRememberRequestSchema,
  type MemoryRememberResponse,
  memoryRememberResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { AgentMessagesService } from './agent-messages.service';
import { MemoryService } from './memory.service';
import { MemoryCheckpointService } from './memory-checkpoint.service';
import { MemoryFactsService } from './memory-facts.service';

/**
 * The memory surface for agents (issue #34).
 *
 * `recall` is a GET on purpose, and not only because it reads nothing but
 * search results: `requiredScopeForRequest` derives the needed scope from the
 * method, so a POST would force every remembering client to hold a `write`
 * token just to look something up.
 */
@ApiTags('memory')
@Controller('api/memory')
export class MemoryController {
  constructor(
    private readonly memory: MemoryService,
    private readonly facts: MemoryFactsService,
    private readonly checkpoints: MemoryCheckpointService,
    private readonly messages: AgentMessagesService,
  ) {}

  @Get('recall')
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'project', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'maxChars', required: false })
  @ApiQuery({ name: 'includeKnowledge', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryRecallResponseSchema) })
  async recall(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(memoryRecallRequestSchema)) query: MemoryRecallRequest,
  ): Promise<MemoryRecallResponse> {
    return this.memory.recall(session.userId, query);
  }

  @Post('remember')
  @ApiBody({ schema: openApiSchema(memoryRememberRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryRememberResponseSchema) })
  async remember(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryRememberRequestSchema)) body: MemoryRememberRequest,
  ): Promise<MemoryRememberResponse> {
    return this.memory.remember({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('capture')
  @ApiBody({ schema: openApiSchema(memoryCaptureRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryCaptureResponseSchema) })
  async capture(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryCaptureRequestSchema)) body: MemoryCaptureRequest,
  ): Promise<MemoryCaptureResponse> {
    return this.memory.capture({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * The checkpoint before a lossy compaction (issue #92).
   *
   * The one call in this controller that keeps its caller waiting, and the one
   * that throws rather than reporting a reason. Both follow from what the
   * caller does next: it is about to drop the wording of its own conversation,
   * and it may only do so once this answered.
   */
  @Post('checkpoint')
  @ApiBody({ schema: openApiSchema(memoryCheckpointRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryCheckpointResponseSchema) })
  async checkpoint(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryCheckpointRequestSchema)) body: MemoryCheckpointRequest,
  ): Promise<MemoryCheckpointResponse> {
    return this.checkpoints.checkpoint({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * The mailbox between agents (issue #51, ADR-047).
   *
   * A `GET` to look and a `POST` to acknowledge, split for the reason the whole
   * controller is split that way: the scope is derived from the method, so a
   * client that only ever collects its post would otherwise need a `write`
   * token to read it. It also keeps the promise the other way round -- looking
   * at the mailbox never empties it.
   */
  @Get('messages')
  @ApiQuery({ name: 'box', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(agentMessageListResponseSchema) })
  async listMessages(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(agentMessageListQuerySchema)) query: AgentMessageListQuery,
  ): Promise<AgentMessageListResponse> {
    return this.messages.list(session.userId, query);
  }

  @Post('messages')
  @ApiBody({ schema: openApiSchema(agentMessageSendRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(agentMessageSendResponseSchema) })
  async sendMessage(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(agentMessageSendRequestSchema)) body: AgentMessageSendRequest,
  ): Promise<AgentMessageSendResponse> {
    return this.messages.send({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('messages/read')
  @ApiBody({ schema: openApiSchema(agentMessageReadRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(agentMessageReadResponseSchema) })
  async markMessagesRead(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(agentMessageReadRequestSchema)) body: AgentMessageReadRequest,
  ): Promise<AgentMessageReadResponse> {
    return this.messages.markRead({ userId: session.userId, ids: body.ids });
  }

  /**
   * The distilled facts of a project (issue #46).
   *
   * A GET for the same reason `recall` is one: reading what is known must not
   * require a `write` token.
   */
  @Get('facts')
  @ApiQuery({ name: 'project', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryFactListResponseSchema) })
  async listFacts(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(memoryFactListQuerySchema)) query: MemoryFactListQuery,
  ): Promise<MemoryFactListResponse> {
    return this.facts.list(session.userId, query);
  }

  /**
   * Applies one consolidation run. The worker's only way in: it decides what a
   * note means, the API decides what that does to the memory.
   */
  @Post('facts')
  @ApiBody({ schema: openApiSchema(memoryConsolidateRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryConsolidateResponseSchema) })
  async consolidate(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(memoryConsolidateRequestSchema)) body: MemoryConsolidateRequest,
  ): Promise<MemoryConsolidateResponse> {
    return this.facts.consolidate({
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('facts/:factId/promote')
  @ApiBody({ schema: openApiSchema(memoryFactPromoteRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(memoryFactPromoteResponseSchema) })
  async promote(
    @CurrentSession() session: VerifiedSession,
    @Param('factId') factId: string,
    @Body(zodPipe(memoryFactPromoteRequestSchema)) body: MemoryFactPromoteRequest,
  ): Promise<MemoryFactPromoteResponse> {
    return this.facts.promote({
      userId: session.userId,
      factId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
