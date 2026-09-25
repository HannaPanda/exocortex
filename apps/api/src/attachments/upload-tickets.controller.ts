import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type FastifyRequest } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateUploadTicketRequest,
  createUploadTicketRequestSchema,
  type CreateUploadTicketResponse,
  createUploadTicketResponseSchema,
  type UploadAttachmentResponse,
  uploadAttachmentResponseSchema,
  type UploadTicketResponse,
  uploadTicketResponseSchema,
} from '@exocortex/contracts';

import { type AuthenticatedRequest, CurrentSession, Public } from '../auth/session.guard';
import { AppError } from '../common/app-error';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { UploadTicketsService } from './upload-tickets.service';

/**
 * Upload tickets (ADR-064): minted and read with a credential, redeemed with
 * the secret in the path and nothing else.
 */
@ApiTags('attachments')
@Controller('api')
export class UploadTicketsController {
  constructor(private readonly tickets: UploadTicketsService) {}

  @Post('workspaces/:workspaceId/attachments/upload-tickets')
  @ApiBody({ schema: openApiSchema(createUploadTicketRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(createUploadTicketResponseSchema) })
  async mint(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createUploadTicketRequestSchema)) body: CreateUploadTicketRequest,
  ): Promise<CreateUploadTicketResponse> {
    const credential = request.exocortexCredential;
    if (credential === undefined) {
      throw AppError.unauthenticated('Route is not protected by SessionGuard');
    }
    return this.tickets.mint({
      workspaceId,
      minter: {
        userId: session.userId,
        credential,
        apiTokenId: request.exocortexApiTokenId,
        credentialExpiresAt: session.expiresAt,
      },
      request: body,
    });
  }

  @Get('workspaces/:workspaceId/attachments/upload-tickets/:ticketId')
  @ApiOkResponse({ schema: openApiResponseSchema(uploadTicketResponseSchema) })
  async get(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Param('ticketId') ticketId: string,
  ): Promise<UploadTicketResponse> {
    const result = await this.tickets.get(ticketId, session.userId);
    // The workspace in the path has to be the ticket's, or the path lies.
    if (result.ticket.workspaceId !== workspaceId) throw AppError.notFound('Upload ticket');
    return result;
  }

  /**
   * The redeem route. Public, because the script holding the file holds no
   * credential and should not have to: the secret in the path is the whole of
   * its authority, and it names one upload into one place.
   *
   * Throttled well below the global limit. A guess has 256 bits against it, so
   * this is not about guessing; it keeps a caller with no ticket from spending
   * this process's time on multipart parsing.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('attachments/upload/:token')
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({ schema: openApiResponseSchema(uploadAttachmentResponseSchema) })
  async redeem(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<UploadAttachmentResponse> {
    return this.tickets.redeem(token, request);
  }
}
