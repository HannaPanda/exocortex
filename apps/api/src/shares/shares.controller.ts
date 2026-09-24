import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateShareRequest,
  createShareRequestSchema,
  type IncomingShareListResponse,
  incomingShareListResponseSchema,
  type MyShareListResponse,
  myShareListResponseSchema,
  type OutgoingShareListResponse,
  outgoingShareListResponseSchema,
  type RevokeShareResponse,
  revokeShareResponseSchema,
  type ShareListResponse,
  shareListResponseSchema,
  type ShareResponse,
  shareResponseSchema,
  type UpdateShareRequest,
  updateShareRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { SharesService } from './shares.service';

/**
 * Page shares (issue #83, ADR-044).
 *
 * A share is addressed by the page it is on while it is being made, and by its
 * own id afterwards -- the same shape as a comment. The personal listings
 * hang under `/api/me`, because "what have I been given" is a question about a
 * person and crosses every workspace they are not a member of.
 */
@ApiTags('shares')
@Controller('api')
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get('documents/:documentId/shares')
  @ApiOkResponse({ schema: openApiResponseSchema(shareListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<ShareListResponse> {
    return this.shares.list(documentId, session.userId);
  }

  @Post('documents/:documentId/shares')
  @ApiBody({ schema: openApiSchema(createShareRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(shareResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
    @Body(zodPipe(createShareRequestSchema)) body: CreateShareRequest,
  ): Promise<ShareResponse> {
    return this.shares.create({
      documentId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  /**
   * The grants a page would inherit at this parent.
   *
   * A GET on the *target*, asked before a move rather than reported after one:
   * dropping a page into a shared branch is the one way to publish something
   * without doing anything that looks like publishing.
   */
  @Get('documents/:documentId/inherited-shares')
  @ApiOkResponse({ schema: openApiResponseSchema(shareListResponseSchema) })
  async inherited(
    @CurrentSession() session: VerifiedSession,
    @Param('documentId') documentId: string,
  ): Promise<ShareListResponse> {
    return this.shares.inheritedAt(documentId, session.userId);
  }

  @Patch('shares/:shareId')
  @ApiBody({ schema: openApiSchema(updateShareRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(shareResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('shareId') shareId: string,
    @Body(zodPipe(updateShareRequestSchema)) body: UpdateShareRequest,
  ): Promise<ShareResponse> {
    return this.shares.update({
      shareId,
      userId: session.userId,
      request: body,
      correlationId: currentCorrelationId(),
    });
  }

  @Delete('shares/:shareId')
  @ApiOkResponse({ schema: openApiResponseSchema(revokeShareResponseSchema) })
  async revoke(
    @CurrentSession() session: VerifiedSession,
    @Param('shareId') shareId: string,
  ): Promise<RevokeShareResponse> {
    return this.shares.revoke({
      shareId,
      userId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Get('workspaces/:workspaceId/shares')
  @ApiOkResponse({ schema: openApiResponseSchema(outgoingShareListResponseSchema) })
  async outgoing(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<OutgoingShareListResponse> {
    return this.shares.listOutgoing(workspaceId, session.userId);
  }

  @Get('me/shares')
  @ApiOkResponse({ schema: openApiResponseSchema(incomingShareListResponseSchema) })
  async incoming(@CurrentSession() session: VerifiedSession): Promise<IncomingShareListResponse> {
    return this.shares.listIncoming(session.userId);
  }

  /** The other direction: what this account gave away, in every workspace. */
  @Get('me/outgoing-shares')
  @ApiOkResponse({ schema: openApiResponseSchema(myShareListResponseSchema) })
  async mine(@CurrentSession() session: VerifiedSession): Promise<MyShareListResponse> {
    return this.shares.listMine(session.userId);
  }
}
