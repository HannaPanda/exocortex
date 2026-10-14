import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { type FastifyReply } from 'fastify';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type CreateDownloadTicketResponse,
  createDownloadTicketResponseSchema,
} from '@exocortex/contracts';

import { type AuthenticatedRequest, CurrentSession, Public } from '../auth/session.guard';
import { AppError } from '../common/app-error';
import { openApiResponseSchema } from '../common/zod';

import { DownloadTicketsService } from './download-tickets.service';
import { fileResponseHeaders } from './file-response-headers';

/**
 * Download tickets (issue #204): minted with a credential, redeemed with the
 * secret in the path and nothing else.
 */
@ApiTags('attachments')
@Controller('api')
export class DownloadTicketsController {
  constructor(private readonly tickets: DownloadTicketsService) {}

  /** A POST because it stores a hash; a read by class (`requestClassFor`). */
  @Post('attachments/:attachmentId/download-tickets')
  @ApiOkResponse({ schema: openApiResponseSchema(createDownloadTicketResponseSchema) })
  async mint(
    @CurrentSession() session: VerifiedSession,
    @Req() request: AuthenticatedRequest,
    @Param('attachmentId') attachmentId: string,
  ): Promise<CreateDownloadTicketResponse> {
    const credential = request.exocortexCredential;
    if (credential === undefined) {
      throw AppError.unauthenticated('Route is not protected by SessionGuard');
    }
    return this.tickets.mint({
      attachmentId,
      minter: {
        userId: session.userId,
        credential,
        apiTokenId: request.exocortexApiTokenId,
        credentialExpiresAt: session.expiresAt,
      },
    });
  }

  /**
   * The redeem route. Public, because the script fetching the file holds no
   * credential and should not have to. Always `attachment`, never `inline`,
   * and with the same sandboxing headers as every other stored file (#177).
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('attachments/download/:token')
  async redeem(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const file = await this.tickets.redeem(token);
    void reply
      .headers({
        ...fileResponseHeaders({
          mimeType: file.mimeType,
          byteSize: file.byteSize,
          filename: file.filename,
          disposition: 'attachment',
        }),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      .send(file.stream);
  }
}
