import { Inject, Injectable } from '@nestjs/common';
import { type FastifyRequest } from 'fastify';

import {
  assertPolicy,
  canUploadFile,
  generateUploadTicket,
  hashUploadTicket,
  looksLikeUploadTicket,
  type PageScopeRestriction,
  tokenHasScope,
  uploadTicketUrl,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  attachmentDownloadPath,
  type CreateUploadTicketRequest,
  type CreateUploadTicketResponse,
  UPLOAD_TICKET_TTL_SECONDS,
  type UploadAttachmentResponse,
  type UploadTicket,
  type UploadTicketState,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import {
  API_TOKEN_CREDENTIAL_SELECT,
  type ApiTokenCredential,
  assertApiTokenUsable,
  pageScopesOf,
} from '../auth/api-token-credential';
import { type ExocortexCredential } from '../auth/session.guard';
import { AppError } from '../common/app-error';
import {
  currentCorrelationId,
  getRequestContext,
  setPageScopeRestriction,
} from '../common/correlation';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { readUploadedFile } from '../common/multipart';
import { PRISMA } from '../platform/platform.module';

import { AttachmentsService } from './attachments.service';

/** Who is minting a ticket, as `SessionGuard` resolved them. */
export interface TicketMinter {
  userId: string;
  credential: ExocortexCredential;
  /** Set when an `exo_` token authenticated the request. */
  apiTokenId: string | undefined;
  /** When the credential itself stops working. */
  credentialExpiresAt: Date;
}

const TICKET_SELECT = {
  id: true,
  workspaceId: true,
  documentId: true,
  filename: true,
  expiresAt: true,
  usedAt: true,
  attachmentId: true,
  createdAt: true,
} satisfies Prisma.AttachmentUploadTicketSelect;

type TicketRow = Prisma.AttachmentUploadTicketGetPayload<{ select: typeof TICKET_SELECT }>;

/**
 * Upload tickets (ADR-064): a one-time address an agent's script POSTs a local
 * file to.
 *
 * The problem they solve is a gap, not a missing feature. An agent that holds
 * a file on disk could only upload it by having its model spell out the bytes
 * as Base64, which no model can do for a photograph, or by putting it somewhere
 * public and handing over the address -- which is how pictures ended up on
 * unrelated sites. A ticket lets the script send the bytes here directly.
 *
 * Redeeming acts as the credential that minted it. Nothing about the upload
 * itself is special: after the ticket is claimed, the file goes through
 * `AttachmentsService.upload` like one dragged into the editor, with the same
 * access check, magic-byte detection and size limit.
 */
@Injectable()
export class UploadTicketsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly attachments: AttachmentsService,
  ) {}

  async mint(input: {
    workspaceId: string;
    minter: TicketMinter;
    request: CreateUploadTicketRequest;
  }): Promise<CreateUploadTicketResponse> {
    // The same check the upload makes, anchored at the same page, so a
    // credential confined to a branch can mint a ticket into it and nowhere
    // else (ADR-044). Redeeming checks again; this answers early.
    const role = await this.access.requireRoleAnchoredAt(
      input.workspaceId,
      input.minter.userId,
      input.request.documentId,
    );
    assertPolicy(canUploadFile(role));
    await this.attachments.assertAttachTarget(input.workspaceId, input.request.documentId);

    const now = Date.now();
    const generated = generateUploadTicket();
    const row = await this.prisma.attachmentUploadTicket.create({
      data: {
        tokenHash: generated.tokenHash,
        workspaceId: input.workspaceId,
        documentId: input.request.documentId,
        filename: input.request.filename,
        createdById: input.minter.userId,
        apiTokenId: input.minter.apiTokenId ?? null,
        expiresAt: ticketExpiry(input.minter, now),
      },
      select: TICKET_SELECT,
    });

    return {
      ticket: toContract(row, now),
      uploadUrl: uploadTicketUrl(this.env.APP_URL, generated.secret),
    };
  }

  /** A ticket the caller minted. Somebody else's ticket does not exist for them. */
  async get(ticketId: string, userId: string): Promise<{ ticket: UploadTicket }> {
    const row = await this.prisma.attachmentUploadTicket.findFirst({
      where: { id: ticketId, createdById: userId },
      select: TICKET_SELECT,
    });
    if (row === null) throw AppError.notFound('Upload ticket');
    // Still able to reach the place it names, under the same confinement the
    // request carries: a ticket is not a way to keep reading a workspace one
    // has left, or a page a confined token no longer covers.
    const role = await this.access.requireRoleAnchoredAt(row.workspaceId, userId, row.documentId);
    if (role === null) throw AppError.notFound('Upload ticket');
    return { ticket: toContract(row, Date.now()) };
  }

  /**
   * Redeems a ticket with the file in `request`.
   *
   * The ticket is claimed before the body is read, so an anonymous caller
   * without a valid ticket never makes this process buffer an upload. A failed
   * upload releases the claim again: a script that sent the wrong field, or a
   * file type that is not allowed, should not cost the agent its ticket.
   */
  async redeem(secret: string, request: FastifyRequest): Promise<UploadAttachmentResponse> {
    if (!looksLikeUploadTicket(secret)) throw invalidTicket();

    const tokenHash = hashUploadTicket(secret);
    const claimedAt = new Date();
    const claimed = await this.prisma.attachmentUploadTicket.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: claimedAt } },
      data: { usedAt: claimedAt },
    });
    if (claimed.count === 0) throw invalidTicket();

    const ticket = await this.prisma.attachmentUploadTicket.findUniqueOrThrow({
      where: { tokenHash },
      select: {
        id: true,
        workspaceId: true,
        documentId: true,
        filename: true,
        createdById: true,
        createdBy: { select: { disabledAt: true } },
        apiToken: { select: API_TOKEN_CREDENTIAL_SELECT },
      },
    });

    try {
      if (ticket.createdBy.disabledAt !== null) {
        throw new AppError('user_disabled', 'This account is disabled');
      }
      this.actAsMintingCredential(ticket.apiToken);

      const file = await readUploadedFile(request, this.env.MAX_UPLOAD_BYTES);
      const uploaded = await this.attachments.upload({
        workspaceId: ticket.workspaceId,
        userId: ticket.createdById,
        documentId: ticket.documentId,
        filename: ticket.filename ?? file.filename,
        declaredMimeType: file.declaredMimeType,
        body: file.body,
        correlationId: currentCorrelationId(),
      });

      await this.prisma.attachmentUploadTicket.update({
        where: { id: ticket.id },
        data: { attachmentId: uploaded.attachment.id },
      });
      this.logger.info('Upload ticket redeemed', {
        ticketId: ticket.id,
        attachmentId: uploaded.attachment.id,
        workspaceId: ticket.workspaceId,
      });
      return uploaded;
    } catch (error) {
      // Only a claim that produced nothing is released, and only by the row
      // id, so a concurrent success can never be undone by this.
      await this.prisma.attachmentUploadTicket
        .updateMany({
          where: { id: ticket.id, attachmentId: null, usedAt: claimedAt },
          data: { usedAt: null },
        })
        .catch((releaseError: unknown) => {
          this.logger.warn('Could not release an upload ticket after a failed upload', {
            ticketId: ticket.id,
            reason: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        });
      throw error;
    }
  }

  /**
   * Puts this request under the authority of the `exo_` token that minted the
   * ticket, or of its owner when no token did.
   *
   * The token is checked as if it had just arrived in a header -- revoked,
   * expired, disabled -- and it must still carry `write`. Its page confinement
   * is installed in the request context, where `requireRoleAnchoredAt` reads
   * it, so a confined token's ticket stays inside the branch it was given.
   * That context must exist: a confinement that could not be installed would
   * be an upload with its owner's full reach, so its absence is a refusal.
   */
  private actAsMintingCredential(token: ApiTokenCredential | null): void {
    let restriction: PageScopeRestriction | null = null;
    if (token !== null) {
      assertApiTokenUsable(token);
      if (!tokenHasScope(token.scopes, 'write')) {
        throw new AppError(
          'api_token_insufficient_scope',
          "This API token does not carry the 'write' scope",
        );
      }
      restriction = pageScopesOf(token) ?? null;
    }
    if (getRequestContext() === undefined) {
      throw AppError.internal('An upload ticket was redeemed outside a request context');
    }
    setPageScopeRestriction(restriction);
  }
}

/**
 * When a new ticket stops working: after the standard lifetime, and never
 * after the credential that minted it.
 *
 * A service token is the exception. The one an OAuth MCP client's call runs on
 * is minted per request and lives two minutes, from an OAuth grant that was
 * itself just verified; capping at it would hand out tickets that expire
 * before a script could run. What such a ticket stands on is the account, and
 * that is re-checked when it is redeemed.
 */
export function ticketExpiry(minter: TicketMinter, now: number): Date {
  const standard = now + UPLOAD_TICKET_TTL_SECONDS * 1000;
  if (minter.credential === 'service_token') return new Date(standard);
  return new Date(Math.min(standard, minter.credentialExpiresAt.getTime()));
}

export function ticketState(
  row: Pick<TicketRow, 'usedAt' | 'expiresAt'>,
  now: number,
): UploadTicketState {
  if (row.usedAt !== null) return 'used';
  return row.expiresAt.getTime() <= now ? 'expired' : 'open';
}

function toContract(row: TicketRow, now: number): UploadTicket {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    filename: row.filename,
    state: ticketState(row, now),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    attachmentId: row.attachmentId,
    embedUrl: row.attachmentId === null ? null : attachmentDownloadPath(row.attachmentId),
    createdAt: row.createdAt.toISOString(),
  };
}

function invalidTicket(): AppError {
  return new AppError('upload_ticket_invalid', 'This upload ticket is not valid');
}
