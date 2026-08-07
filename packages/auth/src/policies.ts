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

export function canPerformDestructiveWorkspaceOperation(role: WorkspaceRole | null): PolicyDecision {
  const read = canReadWorkspace(role);
  if (!read.allowed) return read;
  if (role !== 'OWNER') {
    return deny('forbidden', 'Destructive workspace operations require the OWNER role');
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
  if (!read.allowed) return { allowed: false, code: 'attachment_access_denied', reason: read.reason };
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
  if (!read.allowed) return { allowed: false, code: 'attachment_access_denied', reason: read.reason };
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
