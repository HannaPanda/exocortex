import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type AddAiConversationSourceRequest,
  addAiConversationSourceRequestSchema,
  AI_CONVERSATION_PAGE_SIZE,
  AI_CONVERSATION_SEARCH_LIMIT,
  type AiConversation,
  aiConversationArchivedFilterSchema,
  type AiConversationCompactResponse,
  aiConversationCompactResponseSchema,
  type AiConversationDeleteResponse,
  aiConversationDeleteResponseSchema,
  type AiConversationDetailResponse,
  aiConversationDetailResponseSchema,
  type AiConversationListResponse,
  aiConversationListResponseSchema,
  aiConversationSchema,
  type AiConversationSearchResponse,
  aiConversationSearchResponseSchema,
  type AiConversationSourcesResponse,
  aiConversationSourcesResponseSchema,
  type AiConversationTitleSuggestionResponse,
  aiConversationTitleSuggestionResponseSchema,
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
  type UpdateAiConversationSourceRequest,
  updateAiConversationSourceRequestSchema,
  type UploadChatAttachmentResponse,
  uploadChatAttachmentResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { API_ENV } from '../common/logger.provider';
import { readUploadedFile } from '../common/multipart';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ChatAttachmentsService } from './chat-attachments.service';
import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationSourcesService } from './conversation-sources.service';
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
    private readonly conversationSources: ConversationSourcesService,
    private readonly chatAttachments: ChatAttachmentsService,
    @Inject(API_ENV) private readonly env: ApiEnv,
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
    @Req() request: FastifyRequest,
  ): Promise<AiConversationDetailResponse> {
    return this.conversations.get(conversationId, session.userId, request.headers);
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

  /**
   * The sources pinned beside the open page (issue #75, ADR-043).
   *
   * Every one of these four answers with the whole list rather than with the
   * row it touched: the chip row is a promise about what goes out, and the
   * budget is shared, so adding one source changes the size of the others.
   */
  @Get(':conversationId/sources')
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationSourcesResponseSchema) })
  async listSources(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<AiConversationSourcesResponse> {
    return this.conversationSources.list(conversationId, session.userId);
  }

  @Post(':conversationId/sources')
  @ApiBody({ schema: openApiSchema(addAiConversationSourceRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(aiConversationSourcesResponseSchema) })
  async addSource(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Body(zodPipe(addAiConversationSourceRequestSchema)) body: AddAiConversationSourceRequest,
  ): Promise<AiConversationSourcesResponse> {
    return this.conversationSources.add({ conversationId, userId: session.userId, request: body });
  }

  @Patch(':conversationId/sources/:sourceId')
  @ApiBody({ schema: openApiSchema(updateAiConversationSourceRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationSourcesResponseSchema) })
  async updateSource(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Param('sourceId') sourceId: string,
    @Body(zodPipe(updateAiConversationSourceRequestSchema)) body: UpdateAiConversationSourceRequest,
  ): Promise<AiConversationSourcesResponse> {
    return this.conversationSources.update({
      conversationId,
      sourceId,
      userId: session.userId,
      request: body,
    });
  }

  @Delete(':conversationId/sources/:sourceId')
  @ApiOkResponse({ schema: openApiResponseSchema(aiConversationSourcesResponseSchema) })
  async removeSource(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Param('sourceId') sourceId: string,
  ): Promise<AiConversationSourcesResponse> {
    return this.conversationSources.remove({ conversationId, sourceId, userId: session.userId });
  }

  /**
   * Summarises the conversation's history now (issue #287), the route behind
   * `/compact` and `exo_chat_compact`. Answers at once; the summary arrives as
   * a message and an `ai.conversation.compacted` event.
   */
  @Post(':conversationId/compact')
  @ApiCreatedResponse({ schema: openApiResponseSchema(aiConversationCompactResponseSchema) })
  async compact(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<AiConversationCompactResponse> {
    return this.conversations.compact({
      conversationId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * Suggests a title from the conversation itself (issue #233), the button in
   * the rename dialog. Waits for the model's answer and stores nothing: the
   * title changes only when the person saves it through the PATCH above.
   */
  @Post(':conversationId/title-suggestion')
  @ApiCreatedResponse({
    schema: openApiResponseSchema(aiConversationTitleSuggestionResponseSchema),
  })
  async suggestTitle(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
  ): Promise<AiConversationTitleSuggestionResponse> {
    return this.conversations.suggestTitle({
      conversationId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * A picture for the next message (issue #223), uploaded as soon as it is
   * pasted, dropped or chosen and sent with the message that names it.
   * Multipart like every upload, under the same size limit.
   */
  @Post(':conversationId/attachments')
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({ schema: openApiResponseSchema(uploadChatAttachmentResponseSchema) })
  async uploadAttachment(
    @CurrentSession() session: VerifiedSession,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ): Promise<UploadChatAttachmentResponse> {
    const file = await readUploadedFile(request, this.env.MAX_UPLOAD_BYTES);
    return this.chatAttachments.upload({
      conversationId,
      userId: session.userId,
      filename: file.filename,
      declaredMimeType: file.declaredMimeType,
      body: file.body,
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
    @Req() request: FastifyRequest,
  ): Promise<PostConversationMessageResponse> {
    return this.conversations.postMessage({
      conversationId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
      headers: request.headers,
    });
  }
}
