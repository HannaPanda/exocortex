import {
  type ApiErrorCode,
  type CollaborationAccess,
  WORKSPACE_ROLE_RANK,
  type WorkspaceRole,
} from '@exocortex/contracts';
import { type UserRole } from '@exocortex/database';

/**
 * Pure authorization policies.
 *
 * Every workspace-scoped operation in Exocortex funnels through one of these
 * functions. They are intentionally free of database access so they can be unit
 * tested exhaustively (`policies.test.ts`); the loading of memberships and
 * documents happens in `WorkspaceAccessService`.
 *
 * Role semantics:
 *   GUEST  - read only
 *   MEMBER - read and write documents, upload attachments
 *   ADMIN  - additionally manage members and workspace settings
 *   OWNER  - additionally destructive workspace operations and ownership transfer
 */

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: ApiErrorCode; readonly reason: string };

const ALLOW: PolicyDecision = { allowed: true };

function deny(code: ApiErrorCode, reason: string): PolicyDecision {
  return { allowed: false, code, reason };
}

export interface DocumentPolicySubject {
  readonly id: string;
  readonly workspaceId: string;
  readonly archivedAt: Date | string | null;
}

export interface AttachmentPolicySubject {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdById: string;
  readonly deletedAt: Date | string | null;
}

function hasAtLeast(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimum];
}

function isArchived(document: DocumentPolicySubject): boolean {
  return document.archivedAt !== null;
}

// --------------------------------------------------------------------------
// Workspace level
// --------------------------------------------------------------------------

export function canReadWorkspace(role: WorkspaceRole | null): PolicyDecision {
  if (role === null) {
    return deny('workspace_access_denied', 'User is not a member of this workspace');
  }
  return ALLOW;
}

export function canManageWorkspaceMembers(role: WorkspaceRole | null): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (!hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Managing workspace members requires the ADMIN or OWNER role');
  }
  return ALLOW;
}

/**
 * Changing another member's role. Only owners may grant or revoke ownership, and
 * nobody may demote the last remaining owner.
 */
export function canChangeMemberRole(
  actorRole: WorkspaceRole | null,
  targetRole: WorkspaceRole,
  nextRole: WorkspaceRole,
  remainingOwnerCount: number,
): PolicyDecision {
  const manage = canManageWorkspaceMembers(actorRole);
  if (!manage.allowed) return manage;
  if ((targetRole === 'OWNER' || nextRole === 'OWNER') && actorRole !== 'OWNER') {
    return deny('forbidden', 'Only an OWNER may grant or revoke workspace ownership');
  }
  if (targetRole === 'OWNER' && nextRole !== 'OWNER' && remainingOwnerCount <= 1) {
    return deny('conflict', 'A workspace must keep at least one OWNER');
  }
  return ALLOW;
}

export function canPerformDestructiveWorkspaceOperation(
  role: WorkspaceRole | null,
): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (role !== 'OWNER') {
    return deny('forbidden', 'Destructive workspace operations require the OWNER role');
  }
  return ALLOW;
}

/**
 * Renaming a workspace or changing its slug. Same bar as managing members:
 * both change something every member relies on (the name shown everywhere, or
 * the slug baked into saved links), so a GUEST or MEMBER may not touch it.
 */
export function canUpdateWorkspace(role: WorkspaceRole | null): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (!hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Updating workspace settings requires the ADMIN or OWNER role');
  }
  return ALLOW;
}

/**
 * Overriding a runtime setting for this workspace (issue #52, ADR-023).
 *
 * The same ADMIN bar as renaming, and a separate function on purpose: these
 * two will not stay the same question. A prompt, a model and a budget are the
 * workspace's own business, but the moment a key here costs somebody else
 * money (an own provider key, a raised ceiling) this is where that line gets
 * drawn, and it must not have to be cut out of the rename policy first.
 */
export function canManageWorkspaceSettings(role: WorkspaceRole | null): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (!hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Changing workspace settings requires the ADMIN or OWNER role');
  }
  return ALLOW;
}

// --------------------------------------------------------------------------
// Documents
// --------------------------------------------------------------------------

export function canReadDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  workspaceId: string,
): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (document.workspaceId !== workspaceId) {
    return deny('document_access_denied', 'Document belongs to a different workspace');
  }
  return ALLOW;
}

export function canCreateDocument(role: WorkspaceRole | null): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (!hasAtLeast(role as WorkspaceRole, 'MEMBER')) {
    return deny('forbidden', 'Creating documents requires at least the MEMBER role');
  }
  return ALLOW;
}

export function canEditDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  const create = canCreateDocument(role);
  if (!create.allowed) return create;
  if (isArchived(document)) {
    return deny('document_archived', 'Archived documents are read-only until they are restored');
  }
  return ALLOW;
}

export function canMoveDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  targetParent: DocumentPolicySubject | null,
): PolicyDecision {
  const edit = canEditDocument(role, document);
  if (!edit.allowed) return edit;
  if (targetParent !== null) {
    if (targetParent.workspaceId !== document.workspaceId) {
      return deny(
        'document_cross_workspace',
        'A document cannot be moved under a parent from another workspace',
      );
    }
    if (isArchived(targetParent)) {
      return deny('document_archived', 'A document cannot be moved under an archived parent');
    }
    if (targetParent.id === document.id) {
      return deny('document_move_cycle', 'A document cannot be its own parent');
    }
  }
  return ALLOW;
}

/**
 * Moving a document (and its whole subtree) into a *different* workspace.
 *
 * Distinct from `canMoveDocument`, which rejects a cross-workspace parent
 * outright -- this is the policy for the explicit cross-workspace path, so it
 * has to check both sides: editing rights in the source workspace (the
 * document leaves it) and at least member rights in the target workspace (the
 * document, and everything hanging off it, becomes visible there).
 */
export function canMoveDocumentAcrossWorkspaces(
  sourceRole: WorkspaceRole | null,
  document: DocumentPolicySubject,
  targetRole: WorkspaceRole | null,
  targetParent: DocumentPolicySubject | null,
  targetWorkspaceId: string,
): PolicyDecision {
  const edit = canEditDocument(sourceRole, document);
  if (!edit.allowed) return edit;
  if (targetRole === null) {
    return deny(
      'workspace_access_denied',
      'The acting user is not a member of the target workspace',
    );
  }
  if (!hasAtLeast(targetRole, 'MEMBER')) {
    return deny(
      'forbidden',
      'Moving a page into a workspace requires at least the MEMBER role there',
    );
  }
  if (targetParent !== null) {
    if (targetParent.workspaceId !== targetWorkspaceId) {
      return deny(
        'document_cross_workspace',
        'The target parent does not belong to the target workspace',
      );
    }
    if (isArchived(targetParent)) {
      return deny('document_archived', 'A document cannot be moved under an archived parent');
    }
  }
  return ALLOW;
}

export function canArchiveDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  const edit = canEditDocument(role, document);
  if (!edit.allowed) return edit;
  return ALLOW;
}

export function canRestoreDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  const create = canCreateDocument(role);
  if (!create.allowed) return create;
  if (!isArchived(document)) {
    return deny('conflict', 'Document is not archived');
  }
  return ALLOW;
}

/**
 * Deleting a page for good (issue #31).
 *
 * Two gates, and both are deliberate. The page must be in the trash first, so
 * that no single call can turn a page somebody is working on into nothing --
 * archiving stays the reversible step everyone uses, and deletion only ever
 * applies to something already put aside. And it takes ADMIN, unlike archiving,
 * which every MEMBER may do: this is the one operation in the application that
 * no snapshot, no restore and no backup inside the product can undo.
 */
export function canDeleteDocument(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (!hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Deleting a page permanently requires the ADMIN or OWNER role');
  }
  if (!isArchived(document)) {
    return deny('conflict', 'Only an archived page can be deleted permanently; archive it first');
  }
  return ALLOW;
}

/**
 * Adding, renaming or deleting a database property or view. Deliberately the
 * same bar as `canEditDocument` — Notion does not require a higher role to
 * change a database's schema than to edit one of its rows.
 */
export function canManageDatabaseSchema(
  role: WorkspaceRole | null,
  collection: DocumentPolicySubject,
): PolicyDecision {
  return canEditDocument(role, collection);
}

export function canRestoreSnapshot(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  const edit = canEditDocument(role, document);
  if (!edit.allowed) return edit;
  if (!hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Restoring a snapshot requires the ADMIN or OWNER role');
  }
  return ALLOW;
}

// --------------------------------------------------------------------------
// Comments (issue #18)
// --------------------------------------------------------------------------

export interface CommentPolicySubject {
  readonly id: string;
  readonly documentId: string;
  readonly createdById: string;
}

/**
 * Reading a page's comments is reading the page: they are remarks about it, and
 * anyone who may see the text may see what was said about it.
 */
export function canReadComments(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  workspaceId: string,
): PolicyDecision {
  return canReadDocument(role, document, workspaceId);
}

/**
 * Writing a comment or a reply.
 *
 * The same bar as editing the page, deliberately: a GUEST is a reader, and an
 * archived page is a closed record. Commenting on an archived page would be
 * writing into something the product says is read-only, and the comment would
 * have nowhere to lead.
 */
export function canCreateComment(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  return canEditDocument(role, document);
}

/**
 * Rewriting a comment body. **Only the author**, no matter the role.
 *
 * An ADMIN may delete somebody's remark (below), but not put different words in
 * their mouth. Those are two different powers and they are kept apart on
 * purpose.
 */
export function canEditComment(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  comment: CommentPolicySubject,
  actorUserId: string,
): PolicyDecision {
  const write = canCreateComment(role, document);
  if (!write.allowed) return write;
  if (comment.createdById !== actorUserId) {
    return deny('forbidden', 'Only the author may edit a comment');
  }
  return ALLOW;
}

/**
 * Deleting a comment: its author, or an ADMIN/OWNER cleaning up. The same shape
 * as `canDeleteAttachment`, for the same reason -- somebody has to be able to
 * remove a remark that should never have been made.
 */
export function canDeleteComment(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  comment: CommentPolicySubject,
  actorUserId: string,
): PolicyDecision {
  const write = canCreateComment(role, document);
  if (!write.allowed) return write;
  if (comment.createdById !== actorUserId && !hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Only the author or an ADMIN/OWNER may delete a comment');
  }
  return ALLOW;
}

/**
 * Resolving or reopening a thread. Anyone who may comment may, including on
 * somebody else's thread: "this is dealt with" is a statement about the page,
 * not about the remark, and the person who fixes the thing is rarely the person
 * who reported it.
 */
export function canResolveComment(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
): PolicyDecision {
  return canCreateComment(role, document);
}

// --------------------------------------------------------------------------
// Collaboration tickets
// --------------------------------------------------------------------------

/**
 * Resolves the access mode a member gets for a document. The client never picks
 * its own access level; this is the only place where it is decided.
 */
export function resolveCollaborationAccess(
  role: WorkspaceRole,
  document: DocumentPolicySubject,
): CollaborationAccess {
  if (isArchived(document)) return 'read';
  if (!hasAtLeast(role, 'MEMBER')) return 'read';
  return 'write';
}

export function canIssueCollaborationTicket(
  role: WorkspaceRole | null,
  document: DocumentPolicySubject,
  workspaceId: string,
): PolicyDecision {
  return canReadDocument(role, document, workspaceId);
}

// --------------------------------------------------------------------------
// Attachments
// --------------------------------------------------------------------------

export function canUploadFile(role: WorkspaceRole | null): PolicyDecision {
  const create = canCreateDocument(role);
  if (!create.allowed) return create;
  return ALLOW;
}

export function canDownloadAttachment(
  role: WorkspaceRole | null,
  attachment: AttachmentPolicySubject,
  workspaceId: string,
): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed)
    return { allowed: false, code: 'attachment_access_denied', reason: read.reason };
  if (attachment.workspaceId !== workspaceId) {
    return deny('attachment_access_denied', 'Attachment belongs to a different workspace');
  }
  if (attachment.deletedAt !== null) {
    return deny('not_found', 'Attachment has been deleted');
  }
  return ALLOW;
}

/**
 * Correcting the extracted text, or forcing a re-extraction, both change what
 * the attachment is understood to say (issue #2) -- unlike downloading, which
 * only reads. Anyone who could not upload a file to begin with should not be
 * able to rewrite what one is read as containing, and a forced re-extraction
 * can spend money on a hosted engine, so both require at least MEMBER.
 */
export function canEditAttachmentText(
  role: WorkspaceRole | null,
  attachment: AttachmentPolicySubject,
  workspaceId: string,
): PolicyDecision {
  const download = canDownloadAttachment(role, attachment, workspaceId);
  if (!download.allowed) return download;
  if (!hasAtLeast(role as WorkspaceRole, 'MEMBER')) {
    return deny('forbidden', 'Editing attachment text requires at least the MEMBER role');
  }
  return ALLOW;
}

export function canDeleteAttachment(
  role: WorkspaceRole | null,
  attachment: AttachmentPolicySubject,
  actorUserId: string,
): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed)
    return { allowed: false, code: 'attachment_access_denied', reason: read.reason };
  const isUploader = attachment.createdById === actorUserId;
  if (!isUploader && !hasAtLeast(role as WorkspaceRole, 'ADMIN')) {
    return deny('forbidden', 'Only the uploader or an ADMIN/OWNER may delete an attachment');
  }
  if (!hasAtLeast(role as WorkspaceRole, 'MEMBER')) {
    return deny('forbidden', 'Deleting attachments requires at least the MEMBER role');
  }
  return ALLOW;
}

// --------------------------------------------------------------------------
// Realtime subscriptions
// --------------------------------------------------------------------------

export function canSubscribeToWorkspaceRoom(role: WorkspaceRole | null): PolicyDecision {
  return canReadWorkspace(role);
}

// --------------------------------------------------------------------------
// Global administration
// --------------------------------------------------------------------------

/** Global administration of the deployment, independent of any workspace. */
export function canAdministerDeployment(role: UserRole | null): PolicyDecision {
  return role === 'ADMIN'
    ? ALLOW
    : { allowed: false, code: 'admin_required', reason: 'Global admin role required' };
}
