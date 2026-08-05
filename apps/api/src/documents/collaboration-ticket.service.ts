import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canIssueCollaborationTicket,
  issueCollaborationTicket,
  resolveCollaborationAccess,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type CollaborationTicketResponse } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { API_ENV, LOGGER } from '../common/logger.provider';

/**
 * Issues short-lived collaboration tickets.
 *
 * The access mode is always derived from the server-side policy; a value supplied
 * by the client is ignored. The Hocuspocus document name is the opaque document
 * id and carries no workspace or permission information (ADR-004).
 */
@Injectable()
export class CollaborationTicketService {
  constructor(
    private readonly access: WorkspaceAccessService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async issue(documentId: string, userId: string): Promise<CollaborationTicketResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canIssueCollaborationTicket(context.role, context.document, context.workspaceId));

    const access = resolveCollaborationAccess(context.role, context.document);
    const { ticket, expiresAt } = issueCollaborationTicket({
      secret: this.env.COLLABORATION_TICKET_SECRET,
      userId,
      documentId,
      access,
      ttlSeconds: this.env.COLLABORATION_TICKET_TTL_SECONDS,
    });

    this.logger.debug('Collaboration ticket issued', {
      documentId,
      userId,
      access,
      ttlSeconds: this.env.COLLABORATION_TICKET_TTL_SECONDS,
    });

    return {
      ticket,
      // Opaque: only the document identifier.
      documentName: documentId,
      access,
      expiresAt,
      collaborationUrl: this.env.PUBLIC_COLLABORATION_URL,
    };
  }
}
