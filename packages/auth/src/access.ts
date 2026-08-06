import { type ApiErrorCode, type WorkspaceRole } from '@exocortex/contracts';
import { type PrismaClient, type UserRole } from '@exocortex/database';

import {
  type AttachmentPolicySubject,
  canAdministerDeployment,
  canReadWorkspace,
  type DocumentPolicySubject,
  type PolicyDecision,
} from './policies';

/**
 * Raised when a policy denies an operation. Carries the machine-readable API
 * error code so transport layers (REST, WebSocket, Hocuspocus) map it
 * consistently.
 */
export class AuthorizationError extends Error {
  public readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export function assertPolicy(decision: PolicyDecision): void {
  if (!decision.allowed) {
    throw new AuthorizationError(decision.code, decision.reason);
  }
}

export interface DocumentAccessContext {
  document: DocumentPolicySubject & {
    parentId: string | null;
    title: string;
    type: string;
  };
  role: WorkspaceRole;
  workspaceId: string;
}

/**
 * Database-backed membership lookups.
 *
 * Every workspace-scoped request must go through this service: a client-provided
 * `workspaceId` is never trusted on its own.
 */
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaClient) {}

  async findRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }

  /** Throws `AuthorizationError` when the user is not a member. */
  async requireRole(workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const role = await this.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));
    return role as WorkspaceRole;
  }

  /**
   * Loads a document together with the caller's role in its workspace. Returns
   * `null` when the document does not exist, so callers can answer 404 without
   * leaking whether a foreign document exists.
   */
  async findDocumentContext(
    documentId: string,
    userId: string,
  ): Promise<DocumentAccessContext | null> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        workspaceId: true,
        parentId: true,
        title: true,
        type: true,
        archivedAt: true,
      },
    });
    if (document === null) return null;

    const role = await this.findRole(document.workspaceId, userId);
    if (role === null) return null;

    return { document, role, workspaceId: document.workspaceId };
  }

  /**
   * Same as `findDocumentContext` but throws a document-scoped authorization
   * error when the document is missing or invisible to the caller.
   */
  async requireDocumentContext(
    documentId: string,
    userId: string,
  ): Promise<DocumentAccessContext> {
    const context = await this.findDocumentContext(documentId, userId);
    if (context === null) {
      throw new AuthorizationError(
        'document_access_denied',
        'Document does not exist or is not visible to this user',
      );
    }
    return context;
  }

  async findAttachmentContext(attachmentId: string, userId: string): Promise<{
    attachment: AttachmentPolicySubject & {
      storageKey: string;
      filename: string;
      mimeType: string;
      byteSize: number;
      documentId: string | null;
      textStatus: 'NOT_APPLICABLE' | 'PENDING' | 'READY' | 'FAILED';
      extractedText: string | null;
      textExtractedAt: Date | null;
      textExtractionError: string | null;
      /** Engine-reported facts, shaped by `pdfMetadataSchema`. Parsed by the caller. */
      textMetadata: unknown;
    };
    role: WorkspaceRole;
  } | null> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        workspaceId: true,
        documentId: true,
        createdById: true,
        deletedAt: true,
        storageKey: true,
        filename: true,
        mimeType: true,
        byteSize: true,
        textStatus: true,
        extractedText: true,
        textExtractedAt: true,
        textExtractionError: true,
        textMetadata: true,
      },
    });
    if (attachment === null) return null;
    const role = await this.findRole(attachment.workspaceId, userId);
    if (role === null) return null;
    return { attachment, role };
  }

  async countOwners(workspaceId: string): Promise<number> {
    return this.prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
  }

  /** Global role of a user, or null when the user does not exist. */
  async findGlobalRole(userId: string): Promise<UserRole | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role ?? null;
  }

  /** Throws AuthorizationError when the user is not a global admin. */
  async requireGlobalAdmin(userId: string): Promise<void> {
    const role = await this.findGlobalRole(userId);
    assertPolicy(canAdministerDeployment(role));
  }
}
