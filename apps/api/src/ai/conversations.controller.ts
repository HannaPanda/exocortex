import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AiConversation,
  type AiConversationDetailResponse,
  aiConversationDetailResponseSchema,
  type AiConversationListResponse,
  aiConversationListResponseSchema,
  aiConversationSchema,
  type CreateAiConversationRequest,
  createAiConversationRequestSchema,
  idSchema,
  type PostConversationMessageRequest,
  postConversationMessageRequestSchema,
  type PostConversationMessageResponse,
  postConversationMessageResponseSchema,
  type UpdateAiConversationRequest,
  updateAiConversationRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ConversationsService } from './conversations.service';

const listQuerySchema = z.object({
  workspaceId: idSchema,
  // Query params arrive as strings; only the literal "true" opts in.
  includeArchived: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const archiveResponseSchema = z.object({ archived: z.literal(true) });
type ArchiveResponse = z.infer<typeof archiveResponseSchema>;

/**
 * Persistent AI conversations (D7). A conversation is personal, not shared,
 * even inside a shared workspace: see `ConversationsService` for why every
 * route here requires the caller to be the conversation's own creator.
 */
@ApiTags('ai')
@Controller('api/ai/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'includeArchived', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<AiConversationListResponse> {
    return this.conversations.list({
      workspaceId: query.workspaceId,
      userId: session.userId,
      includeArchived: query.includeArchived,
    });
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createAiConversationRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(aiConversationSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createAiConversationRequestSchema)) body: CreateAiConversationRequest,
  ): Promise<{ conversation: AiConversation }> {
    return this.conversations.create({ userId: session.userId, request: body });
  }

  @Get(':conversationId')
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationDetailResponseSchema) })
  async detail(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<AiConversationDetailResponse> {
    return this.conversations.get(conversationId, session.userId);
  }

  @Patch(':conversationId')
  @ApiBody({ schema: openApiSchema(updateAiConversationRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Body(zodPipe(updateAiConversationRequestSchema)) body: UpdateAiConversationRequest,
  ): Promise<{ conversation: AiConversation }> {
    return this.conversations.update({ conversationId, userId: session.userId, request: body });
  }

  @Delete(':conversationId')
  @ApiOkResponse({ schema: openApiResponseSchema(archiveResponseSchema) })
  async archive(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<ArchiveResponse> {
    return this.conversations.archive(conversationId, session.userId);
  }

  @Post(':conversationId/messages')
  @ApiBody({ schema: openApiSchema(postConversationMessageRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(postConversationMessageResponseSchema) })
  async postMessage(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Body(zodPipe(postConversationMessageRequestSchema)) body: PostConversationMessageRequest,
  ): Promise<PostConversationMessageResponse> {
    return this.conversations.postMessage({
      conversationId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
