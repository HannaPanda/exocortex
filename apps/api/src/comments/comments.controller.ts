import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CommentListResponse,
  commentListResponseSchema,
  type CommentResponse,
  commentResponseSchema,
  type CreateCommentRequest,
  createCommentRequestSchema,
  type DeleteCommentResponse,
  deleteCommentResponseSchema,
  type ListCommentsQuery,
  listCommentsQuerySchema,
  type ResolveCommentRequest,
  resolveCommentRequestSchema,
  type UpdateCommentRequest,
  updateCommentRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { CommentsService } from './comments.service';

/** Comments of one page. The page is what authorizes every call (issue #18). */
@ApiTags('comments')
@Controller('api/documents/:documentId/comments')
export class DocumentCommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get()
  @ApiQuery({ name: 'includeResolved', required: false, schema: { type: 'boolean' } })
  @ApiOkResponse({ schema: openApiResponseSchema(commentListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Query(zodPipe(listCommentsQuerySchema)) query: ListCommentsQuery,
  ): Promise<CommentListResponse> {
    return this.comments.list({
      documentId,
      userId: session.userId,
      includeResolved: query.includeResolved,
    });
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createCommentRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(commentResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createCommentRequestSchema)) body: CreateCommentRequest,
  ): Promise<CommentResponse> {
    const comment = await this.comments.create({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
    return { comment };
  }
}

/** A single comment, addressed by its own id. */
@ApiTags('comments')
@Controller('api/comments')
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Patch(':commentId')
  @ApiBody({ schema: openApiSchema(updateCommentRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(commentResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('commentId') commentId: string,
    @Body(zodPipe(updateCommentRequestSchema)) body: UpdateCommentRequest,
  ): Promise<CommentResponse> {
    const comment = await this.comments.update({
      commentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
    return { comment };
  }

  @Post(':commentId/resolve')
  @ApiBody({ schema: openApiSchema(resolveCommentRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(commentResponseSchema) })
  async resolve(
    @CurrentSession() session: VerifiedSession,
    @Param('commentId') commentId: string,
    @Body(zodPipe(resolveCommentRequestSchema)) body: ResolveCommentRequest,
  ): Promise<CommentResponse> {
    const comment = await this.comments.setResolved({
      commentId,
      userId: session.userId,
      resolved: body.resolved,
      correlationId: currentCorrelationId(),
    });
    return { comment };
  }

  @Delete(':commentId')
  @ApiOkResponse({ schema: openApiResponseSchema(deleteCommentResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('commentId') commentId: string,
  ): Promise<DeleteCommentResponse> {
    return this.comments.remove({
      commentId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }
}
