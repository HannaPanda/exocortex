import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CaptureRequest,
  captureRequestSchema,
  type CaptureResponse,
  captureResponseSchema,
  type ClipRequest,
  clipRequestSchema,
  type ClipResponse,
  clipResponseSchema,
  type InboxQuery,
  inboxQuerySchema,
  type InboxResponse,
  inboxResponseSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ClipService } from './clip.service';
import { InboxService } from './inbox.service';

/**
 * Quick capture (issue #71, ADR-036).
 *
 * Two routes, because there are two questions: "take this" and "what is still
 * lying around". Filing is deliberately not a third one -- moving a page is
 * `POST /api/documents/:id/move`, and a second way to move a page would be a
 * second set of rules about where a page may go.
 */
@ApiTags('inbox')
@Controller('api/workspaces/:workspaceId')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly clips: ClipService,
  ) {}

  @Get('inbox')
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ schema: openApiResponseSchema(inboxResponseSchema) })
  async read(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query(zodPipe(inboxQuerySchema)) query: InboxQuery,
  ): Promise<InboxResponse> {
    return this.inbox.read({ workspaceId, userId: session.userId, limit: query.limit });
  }

  @Post('capture')
  @ApiBody({ schema: openApiSchema(captureRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(captureResponseSchema) })
  async capture(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(captureRequestSchema)) body: CaptureRequest,
  ): Promise<CaptureResponse> {
    return this.inbox.capture({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Post('clip')
  @ApiBody({ schema: openApiSchema(clipRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(clipResponseSchema) })
  async clip(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(clipRequestSchema)) body: ClipRequest,
  ): Promise<ClipResponse> {
    return this.clips.clip({
      workspaceId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }
}
