import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AcceptInvitationRequest,
  acceptInvitationRequestSchema,
  type AcceptInvitationResponse,
  acceptInvitationResponseSchema,
  type CreateInvitationRequest,
  createInvitationRequestSchema,
  type InvitationListResponse,
  invitationListResponseSchema,
  type InvitationPreview,
  invitationPreviewSchema,
  type InvitationWithLink,
  invitationWithLinkSchema,
  type RevokeInvitationResponse,
  revokeInvitationResponseSchema,
} from '@exocortex/contracts';

import { AdminOnly } from '../auth/admin.guard';
import { CurrentSession, Public } from '../auth/session.guard';
import { currentCorrelationId } from '../common/correlation';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { InvitationsService } from './invitations.service';

/**
 * The token is read from the body, never from the path.
 *
 * A path segment ends up in nginx's access log; a body does not. The link a
 * person clicks unavoidably carries the token in a URL (that is what a link is),
 * but there is no reason for the API call behind it to repeat the mistake.
 */
const invitationTokenRequestSchema = z.object({ token: z.string().min(16).max(200) });
type InvitationTokenRequest = z.infer<typeof invitationTokenRequestSchema>;

/**
 * Deployment-wide invitation management. `@AdminOnly()` on the class, like
 * `AdminController`, so no route added later can be forgotten.
 */
@ApiTags('admin')
@AdminOnly()
@Controller('api/admin/invitations')
export class AdminInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(invitationListResponseSchema) })
  async list(): Promise<InvitationListResponse> {
    return { invitations: await this.invitations.listAll() };
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createInvitationRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(invitationWithLinkSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Body(zodPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ): Promise<InvitationWithLink> {
    return this.invitations.createAsAdmin({
      request: body,
      actorUserId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':invitationId/resend')
  @ApiOkResponse({ schema: openApiResponseSchema(invitationWithLinkSchema) })
  async resend(
    @CurrentSession() session: VerifiedSession,
    @Param('invitationId') invitationId: string,
  ): Promise<InvitationWithLink> {
    return this.invitations.resend({ invitationId, actorUserId: session.userId });
  }

  @Delete(':invitationId')
  @ApiOkResponse({ schema: openApiResponseSchema(revokeInvitationResponseSchema) })
  async revoke(
    @CurrentSession() session: VerifiedSession,
    @Param('invitationId') invitationId: string,
  ): Promise<RevokeInvitationResponse> {
    await this.invitations.revoke({ invitationId, actorUserId: session.userId });
    return { revoked: true };
  }
}

/**
 * Inviting from inside a workspace. The workspace comes from the URL and the
 * policy check is `canManageWorkspaceMembers`, so an OWNER or ADMIN of that one
 * workspace can add a collaborator without going through the operator.
 */
@ApiTags('workspaces')
@Controller('api/workspaces/:workspaceId/invitations')
export class WorkspaceInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(invitationListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<InvitationListResponse> {
    return {
      invitations: await this.invitations.listForWorkspace(workspaceId, session.userId),
    };
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createInvitationRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(invitationWithLinkSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
  ): Promise<InvitationWithLink> {
    return this.invitations.createForWorkspace({
      workspaceId,
      request: body,
      actorUserId: session.userId,
      correlationId: currentCorrelationId(),
    });
  }

  @Post(':invitationId/resend')
  @ApiOkResponse({ schema: openApiResponseSchema(invitationWithLinkSchema) })
  async resend(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<InvitationWithLink> {
    return this.invitations.resend({ invitationId, actorUserId: session.userId, workspaceId });
  }

  @Delete(':invitationId')
  @ApiOkResponse({ schema: openApiResponseSchema(revokeInvitationResponseSchema) })
  async revoke(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<RevokeInvitationResponse> {
    await this.invitations.revoke({ invitationId, actorUserId: session.userId, workspaceId });
    return { revoked: true };
  }
}

/**
 * The two unauthenticated routes: looking at an invitation and redeeming it.
 *
 * Both carry their own rate limit, far below the global 300/min. A token is 256
 * bits of entropy and cannot be guessed, but the limit is not really about
 * guessing: these are the only routes in the deployment that an anonymous
 * request can use to create a row, and the cost of a redemption (a password
 * hash) is deliberately high. Ten preview attempts and five redemptions a minute
 * per address is more than a real person needs and far less than a script wants.
 */
@ApiTags('invitations')
@Controller('api/invitations')
export class PublicInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('preview')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(invitationTokenRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(invitationPreviewSchema) })
  async preview(
    @Body(zodPipe(invitationTokenRequestSchema)) body: InvitationTokenRequest,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(body.token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('accept')
  @HttpCode(200)
  @ApiBody({ schema: openApiSchema(acceptInvitationRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(acceptInvitationResponseSchema) })
  async accept(
    @Body(zodPipe(acceptInvitationRequestSchema)) body: AcceptInvitationRequest,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept(body);
  }
}
