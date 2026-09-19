import { type ApiErrorCode, type WorkspaceRole } from '@exocortex/contracts';
import {
  loadAncestorChain,
  loadSubtreeIds,
  type PrismaClient,
  type UserRole,
} from '@exocortex/database';

import {
  type DocumentGrant,
  isRestricted,
  type PageScopeRestriction,
  type PageScopeRestrictionProvider,
  restrictionAllows,
  roleForSharePermission,
  selectShareGrant,
  type ShareGrantRow,
} from './document-grants';
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
  /**
   * Where `role` came from (issue #83, ADR-044). A share stands in for a role,
   * so everything downstream keeps working unchanged -- but the two are not
   * interchangeable everywhere: anything that answers with more than the one
   * page has to stop at `rootId` rather than at the workspace, because a
   * breadcrumb, a sibling list or a backlink is exactly how a shared page
   * would hand over the pages around it.
   */
  grant: DocumentGrant;
}

/**
 * What a workspace-wide read may look at.
 *
 * `documentIds === null` means the whole workspace, which is what an ordinary
 * member gets. A set means the credential is confined and the caller must
 * filter by it; the set is already closed over the hierarchy, so an `IN` is
 * enough and no caller has to walk anything.
 */
export interface ScopedWorkspaceAccess {
  role: WorkspaceRole;
  documentIds: Set<string> | null;
}

/**
 * Database-backed membership lookups.
 *
 * Every workspace-scoped request must go through this service: a client-provided
 * `workspaceId` is never trusted on its own.
 *
 * Since issue #83 it answers two further questions in the same place, on
 * purpose (ADR-044): whether a page is reachable through a *share* rather than
 * a membership, and whether the credential making the request is confined to a
 * branch. Both belong here because both would otherwise have to be remembered
 * by every endpoint, and the one that forgets is the one that leaks.
 */
export class WorkspaceAccessService {
  private readonly restrictions: PageScopeRestrictionProvider | null;

  constructor(
    private readonly prisma: PrismaClient,
    /**
     * How the page confinement of the current credential is read. Left out by
     * the collaboration server and by tests, where there is no request to read
     * it from and therefore nothing to confine.
     */
    restrictions?: PageScopeRestrictionProvider,
  ) {
    this.restrictions = restrictions ?? null;
  }

  private currentRestriction(): PageScopeRestriction | null {
    return this.restrictions?.current() ?? null;
  }

  /**
   * The membership row, and nothing else.
   *
   * Deliberately blind to the credential's confinement, so it is the wrong
   * function for almost every caller. It exists for the three questions that
   * are genuinely about the *account* rather than about this request: whether
   * the person a page is being shared with is already a member, what the
   * realtime gateway should do with a socket, and what the two functions below
   * build on.
   */
  async findMembershipRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return membership?.role ?? null;
  }

  /**
   * The caller's role in a workspace, for an operation that names no page.
   *
   * Refuses a confined credential outright (issue #83, ADR-044). That is the
   * whole design: there are about forty callers of this function, they were
   * all written before page scopes existed, and asking each of them to
   * remember a new rule is asking the wrong question. A caller that *can*
   * honour a confinement says so explicitly -- `requireScopedRole` when it
   * will filter the answer, `requireRoleAnchoredAt` when the operation does
   * name a page after all -- and everything else fails closed.
   */
  async findRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    if (isRestricted(this.currentRestriction())) {
      throw new AuthorizationError(
        'token_scope_exceeded',
        'This credential is limited to certain pages and cannot act on the whole workspace',
      );
    }
    return this.findMembershipRole(workspaceId, userId);
  }

  /**
   * The caller's role, for an operation whose target is one page.
   *
   * Creating a page under a parent, uploading a file onto one, importing into
   * one: the authority comes from the workspace but the confinement is decided
   * by the page, so neither `findRole` nor `findDocumentContext` fits on its
   * own. A confined credential and no page at all (a new page at the workspace
   * root) is a refusal, because the root is exactly what such a credential was
   * kept away from.
   */
  async requireRoleAnchoredAt(
    workspaceId: string,
    userId: string,
    documentId: string | null,
  ): Promise<WorkspaceRole | null> {
    const restriction = this.currentRestriction();
    if (isRestricted(restriction)) {
      if (documentId === null) {
        throw new AuthorizationError(
          'token_scope_exceeded',
          'This credential is limited to certain pages and cannot act at the workspace root',
        );
      }
      const chain = await loadAncestorChain(this.prisma, documentId);
      if (!restrictionAllows(restriction, chain)) {
        throw new AuthorizationError(
          'token_scope_exceeded',
          'This credential is limited to certain pages and that page is not one of them',
        );
      }
    }

    const role = await this.findMembershipRole(workspaceId, userId);
    if (role !== null || documentId === null) return role;

    // Not a member, but possibly the holder of a grant on this very page. This
    // is what makes a WRITE share of a branch mean what it says: somebody who
    // may edit the pages in it may also add one, and without this they could
    // change every existing page and create none.
    const context = await this.findDocumentContext(documentId, userId);
    if (context === null) return null;
    return context.grant.source === 'share' && context.grant.scope === 'SUBTREE'
      ? context.role
      : null;
  }

  /**
   * Throws `AuthorizationError` when the user is not a member.
   *
   * Fails closed for a confined credential (issue #83): a workspace-wide
   * question has no answer that stays inside one branch, so the ones that can
   * be narrowed ask `requireScopedRole` instead and narrow themselves. Adding
   * a workspace-wide route therefore costs a confined token nothing but an
   * honest refusal, which is the failure mode this split exists to guarantee.
   */
  async requireRole(workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const role = await this.findMembershipRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));
    if (isRestricted(this.currentRestriction())) {
      throw new AuthorizationError(
        'token_scope_exceeded',
        'This credential is limited to certain pages and cannot act on the whole workspace',
      );
    }
    return role as WorkspaceRole;
  }

  /**
   * Membership plus the set of pages this credential may see in it.
   *
   * For the readers that *can* narrow: search, the tree, link resolution, the
   * trash. They get a set and must filter by it before anything leaves the
   * process -- counts and paths included, since a count is an answer about
   * pages the caller may not name.
   */
  async requireScopedRole(workspaceId: string, userId: string): Promise<ScopedWorkspaceAccess> {
    const role = await this.findMembershipRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const restriction = this.currentRestriction();
    if (!isRestricted(restriction)) return { role: role as WorkspaceRole, documentIds: null };

    const allowed = await this.confinedDocumentIds(restriction as PageScopeRestriction);

    // The scope may name pages in another workspace; this answer is about one.
    const here = await this.prisma.document.findMany({
      where: { id: { in: [...allowed] }, workspaceId },
      select: { id: true },
    });
    return { role: role as WorkspaceRole, documentIds: new Set(here.map((row) => row.id)) };
  }

  /**
   * Loads a document together with the caller's authority over it. Returns
   * `null` when the document does not exist, is invisible to the caller, or
   * lies outside what the credential may reach -- one answer for all three, so
   * callers answer 404 without leaking which it was.
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

    const restriction = this.currentRestriction();
    const role = await this.findMembershipRole(document.workspaceId, userId);

    // The chain is loaded once and answers both questions: whether the
    // credential reaches here, and which share does.
    const needsChain = isRestricted(restriction) || role === null;
    const chain = needsChain ? await loadAncestorChain(this.prisma, documentId) : [];

    if (!restrictionAllows(restriction, chain)) return null;

    if (role !== null) {
      return { document, role, workspaceId: document.workspaceId, grant: { source: 'membership' } };
    }

    const grant = selectShareGrant(chain, await this.loadShareGrants(chain, userId));
    if (grant === null) return null;

    return {
      document,
      role: roleForSharePermission(grant.permission),
      workspaceId: document.workspaceId,
      grant: {
        source: 'share',
        shareId: grant.id,
        rootId: grant.documentId,
        scope: grant.scope,
        permission: grant.permission,
      },
    };
  }

  /**
   * Which other pages a caller who reached *this* page may be told about.
   *
   * `null` means the whole workspace, which is what a member with an
   * unconfined credential gets. Anything else is a set, and the callers that
   * need it are the ones answering with pages other than the one that was
   * asked for: backlinks, related pages, a reference's target. Those are
   * exactly the routes through which a single shared page would otherwise hand
   * over the titles and the surrounding sentences of pages nobody shared.
   */
  async visibleDocumentIds(context: DocumentAccessContext): Promise<Set<string> | null> {
    const restriction = this.currentRestriction();

    if (context.grant.source === 'share') {
      const shared =
        context.grant.scope === 'SUBTREE'
          ? await loadSubtreeIds(this.prisma, [context.grant.rootId])
          : new Set([context.grant.rootId]);
      if (!isRestricted(restriction)) return shared;
      const confined = await this.confinedDocumentIds(restriction as PageScopeRestriction);
      return new Set([...shared].filter((id) => confined.has(id)));
    }

    if (!isRestricted(restriction)) return null;
    return this.confinedDocumentIds(restriction as PageScopeRestriction);
  }

  /** Every page a confinement covers, closed over the hierarchy. */
  private async confinedDocumentIds(restriction: PageScopeRestriction): Promise<Set<string>> {
    const allowed = await loadSubtreeIds(
      this.prisma,
      restriction.scopes
        .filter((entry) => entry.scope === 'SUBTREE')
        .map((entry) => entry.documentId),
    );
    for (const entry of restriction.scopes) {
      if (entry.scope === 'PAGE_ONLY') allowed.add(entry.documentId);
    }
    return allowed;
  }

  /** Live grants this user holds anywhere along a page's chain of ancestors. */
  private async loadShareGrants(
    chain: readonly string[],
    userId: string,
  ): Promise<ShareGrantRow[]> {
    if (chain.length === 0) return [];
    const now = new Date();
    const rows = await this.prisma.documentShare.findMany({
      where: {
        documentId: { in: [...chain] },
        kind: 'USER',
        granteeId: userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, documentId: true, scope: true, permission: true },
    });
    return rows;
  }

  /**
   * Same as `findDocumentContext` but throws a document-scoped authorization
   * error when the document is missing or invisible to the caller.
   */
  async requireDocumentContext(documentId: string, userId: string): Promise<DocumentAccessContext> {
    const context = await this.findDocumentContext(documentId, userId);
    if (context === null) {
      throw new AuthorizationError(
        'document_access_denied',
        'Document does not exist or is not visible to this user',
      );
    }
    return context;
  }

  async findAttachmentContext(
    attachmentId: string,
    userId: string,
  ): Promise<{
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
      /** True when `extractedText` was cut off at `ATTACHMENT_TEXT_MAX_CHARS`. */
      textTruncated: boolean;
      /** Human correction of `extractedText` (issue #2); absent when nobody has corrected it. */
      correctedText: string | null;
      textCorrectedAt: Date | null;
      textCorrectedById: string | null;
      /** Downscaled copy, or null when there is none and the original is it. */
      previewKey: string | null;
      previewMimeType: string | null;
      previewByteSize: number | null;
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
        textTruncated: true,
        correctedText: true,
        textCorrectedAt: true,
        textCorrectedById: true,
        previewKey: true,
        previewMimeType: true,
        previewByteSize: true,
      },
    });
    if (attachment === null) return null;

    // A file takes the access of the page it hangs on (issue #83): that is what
    // makes a shared page's images visible to the person it was shared with,
    // and what stops a confined token from reading a file whose page it may not
    // read. A file that hangs on no page belongs to the workspace alone.
    if (attachment.documentId !== null) {
      const context = await this.findDocumentContext(attachment.documentId, userId);
      if (context === null) return null;
      return { attachment, role: context.role };
    }

    if (isRestricted(this.currentRestriction())) return null;
    const role = await this.findMembershipRole(attachment.workspaceId, userId);
    if (role === null) return null;
    return { attachment, role };
  }

  /**
   * The subset of `userIds` whose account is switched off.
   *
   * Used by the periodic re-authorization sweeps (issue #62): disabling an
   * account deletes its credentials, which stops every new request, but a
   * WebSocket that was authenticated before the switch has no credential to
   * lose. One query for the whole connection table beats one per connection.
   */
  async findDisabledUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set<string>();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds }, disabledAt: { not: null } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async countOwners(workspaceId: string): Promise<number> {
    return this.prisma.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
  }

  /** Global role of a user, or null when the user does not exist. */
  async findGlobalRole(userId: string): Promise<UserRole | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role ?? null;
  }

  /** Throws AuthorizationError when the user is not a global admin. */
  async requireGlobalAdmin(userId: string): Promise<void> {
    if (isRestricted(this.currentRestriction())) {
      throw new AuthorizationError(
        'token_scope_exceeded',
        'A page-scoped credential can never administer the deployment',
      );
    }
    const role = await this.findGlobalRole(userId);
    assertPolicy(canAdministerDeployment(role));
  }
}
