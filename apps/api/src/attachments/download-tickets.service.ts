import { type Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canDownloadAttachment,
  downloadTicketUrl,
  generateDownloadTicket,
  hashDownloadTicket,
  looksLikeDownloadTicket,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type CreateDownloadTicketResponse,
  DOWNLOAD_TICKET_TTL_SECONDS,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { API_TOKEN_CREDENTIAL_SELECT } from '../auth/api-token-credential';
import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';

import { AttachmentsService } from './attachments.service';
import { actAsMintingCredential, ticketExpiry, type TicketMinter } from './upload-tickets.service';

/**
 * Download tickets (issue #204): a one-time address an agent's script GETs one
 * attachment from.
 *
 * The mirror of the upload tickets (ADR-064), for the files that should not
 * pass through a model: a PDF, an archive, the full-size original of a photo.
 * Without one an agent would either have to put its bearer token into a shell
 * command, or ask for the bytes as Base64 through a tool call, which is the
 * context window paying for a file the model never needed to read.
 *
 * Redeeming acts as the credential that minted it and then goes through
 * `AttachmentsService.download` like any other download, so access is decided
 * twice: when the ticket is minted, and again when it is used.
 */
@Injectable()
export class DownloadTicketsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly attachments: AttachmentsService,
  ) {}

  async mint(input: {
    attachmentId: string;
    minter: TicketMinter;
  }): Promise<CreateDownloadTicketResponse> {
    const context = await this.access.findAttachmentContext(
      input.attachmentId,
      input.minter.userId,
    );
    if (context === null) {
      throw new AppError(
        'attachment_access_denied',
        'Attachment does not exist or is not visible to this user',
      );
    }
    const { attachment } = context;
    assertPolicy(canDownloadAttachment(context.role, attachment, attachment.workspaceId));

    const now = Date.now();
    const generated = generateDownloadTicket();
    const row = await this.prisma.attachmentDownloadTicket.create({
      data: {
        tokenHash: generated.tokenHash,
        attachmentId: attachment.id,
        createdById: input.minter.userId,
        apiTokenId: input.minter.apiTokenId ?? null,
        expiresAt: ticketExpiry(input.minter, now, DOWNLOAD_TICKET_TTL_SECONDS),
      },
      select: { id: true, expiresAt: true, createdAt: true },
    });

    return {
      ticket: {
        id: row.id,
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      },
      downloadUrl: downloadTicketUrl(this.env.APP_URL, generated.secret),
    };
  }

  /**
   * Redeems a ticket: the file, once.
   *
   * Claimed before anything is read, and not released when the download
   * fails. Unlike an upload, nothing a caller could correct went wrong: a
   * failure here means access was lost or the file is gone, and a second try
   * with the same secret would fail the same way.
   */
  async redeem(
    secret: string,
  ): Promise<{ stream: Readable; filename: string; mimeType: string; byteSize: number }> {
    if (!looksLikeDownloadTicket(secret)) throw invalidTicket();

    const tokenHash = hashDownloadTicket(secret);
    const claimedAt = new Date();
    const claimed = await this.prisma.attachmentDownloadTicket.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: claimedAt } },
      data: { usedAt: claimedAt },
    });
    if (claimed.count === 0) throw invalidTicket();

    const ticket = await this.prisma.attachmentDownloadTicket.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        id: true,
        attachmentId: true,
        createdById: true,
        createdBy: { select: { disabledAt: true } },
        apiToken: { select: API_TOKEN_CREDENTIAL_SELECT },
      },
    });
    if (ticket.createdBy.disabledAt !== null) {
      throw new AppError('user_disabled', 'This account is disabled');
    }
    actAsMintingCredential(ticket.apiToken, 'read');

    const file = await this.attachments.download(ticket.attachmentId, ticket.createdById);
    this.logger.info('Download ticket redeemed', {
      ticketId: ticket.id,
      attachmentId: ticket.attachmentId,
    });
    return file;
  }
}

function invalidTicket(): AppError {
  return new AppError('download_ticket_invalid', 'This download ticket is not valid');
}
