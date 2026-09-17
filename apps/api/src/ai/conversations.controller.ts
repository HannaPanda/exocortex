import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  AI_CONVERSATION_PAGE_SIZE,
  AI_CONVERSATION_SEARCH_LIMIT,
  type AiConversation,
  aiConversationArchivedFilterSchema,
  type AiConversationDeleteResponse,
  aiConversationDeleteResponseSchema,
  type AiConversationDetailResponse,
  aiConversationDetailResponseSchema,
  type AiConversationListResponse,
  aiConversationListResponseSchema,
  aiConversationSchema,
  type AiConversationSearchResponse,
  aiConversationSearchResponseSchema,
  type ConversationToPageRequest,
  conversationToPageRequestSchema,
  type ConversationToPageResponse,
  conversationToPageResponseSchema,
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

import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationsService } from './conversations.service';

/** Query params arrive as strings; every coercion this controller needs is here. */
const positiveIntFromQuery = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined ? fallback : Number.parseInt(value, 10)))
    .refine((value) => Number.isInteger(value) && value > 0, 'must be a positive integer');

/**
 * `includeArchived=true` is kept alongside the three-valued `archived` because
 * it is what the panel has always sent; `archived` wins when both are given.
 */
const listQuerySchema = z.object({
  workspaceId: idSchema.optional(),
  documentId: idSchema.optional(),
  archived: aiConversationArchivedFilterSchema.optional(),
  includeArchived: z
    .string()
    .optional()
    .transform((value) => value === 'true'),
  limit: positiveIntFromQuery(AI_CONVERSATION_PAGE_SIZE),
  cursor: z.string().min(1).max(200).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  workspaceId: idSchema.optional(),
  archived: aiConversationArchivedFilterSchema.optional(),
  limit: positiveIntFromQuery(AI_CONVERSATION_SEARCH_LIMIT),
});
type SearchQuery = z.infer<typeof searchQuerySchema>;

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
  constructor(
    private readonly conversations: ConversationsService,
    private readonly conversationArchive: ConversationArchiveService,
  ) {}

  @Get()
  @ApiQuery({ name: 'workspaceId', required: false })
  @ApiQuery({ name: 'documentId', required: false })
  @ApiQuery({ name: 'archived', required: false, enum: ['open', 'archived', 'all'] })
  @ApiQuery({ name: 'includeArchived', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(listQuerySchema)) query: ListQuery,
  ): Promise<AiConversationListResponse> {
    return this.conversationArchive.list({
      userId: session.userId,
      workspaceId: query.workspaceId ?? null,
      documentId: query.documentId ?? null,
      archived: query.archived ?? (query.includeArchived ? 'all' : 'open'),
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  }

  /**
   * Declared before `:conversationId` on purpose: Nest matches in declaration
   * order, and a parameter route above this one would swallow `/search`.
   */
  @Get('search')
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'workspaceId', required: false })
  @ApiQuery({ name: 'archived', required: false, enum: ['open', 'archived', 'all'] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationSearchResponseSchema) })
  async search(
    @CurrentSession() session: VerifiedSession,
    @Query(zodPipe(searchQuerySchema)) query: SearchQuery,
  ): Promise<AiConversationSearchResponse> {
    return this.conversationArchive.searchMessages({
      userId: session.userId,
      query: query.q,
      workspaceId: query.workspaceId ?? null,
      archived: query.archived ?? 'all',
      limit: query.limit,
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

  /** Irreversible, unlike `DELETE :conversationId`, which only archives. */
  @Delete(':conversationId/permanent')
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationDeleteResponseSchema) })
  async deletePermanently(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<AiConversationDeleteResponse> {
    return this.conversationArchive.deletePermanently(conversationId, session.userId);
  }

  @Post(':conversationId/to-page')
  @ApiBody({ schema: openApiSchema(conversationToPageRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(conversationToPageResponseSchema) })
  async toPage(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Body(zodPipe(conversationToPageRequestSchema)) body: ConversationToPageRequest,
  ): Promise<ConversationToPageResponse> {
    return this.conversationArchive.toPage({
      conversationId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
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
