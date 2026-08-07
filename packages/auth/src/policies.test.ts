import { describe, expect, it } from 'vitest';

import { type WorkspaceRole } from '@exocortex/contracts';

import {
  canArchiveDocument,
  canChangeMemberRole,
  canCreateDocument,
  canDeleteAttachment,
  canDownloadAttachment,
  canEditAttachmentText,
  canEditDocument,
  canIssueCollaborationTicket,
  canManageDatabaseSchema,
  canManageWorkspaceMembers,
  canMoveDocument,
  canMoveDocumentAcrossWorkspaces,
  canPerformDestructiveWorkspaceOperation,
  canReadDocument,
  canReadWorkspace,
  canRestoreSnapshot,
  canSubscribeToWorkspaceRoom,
  canUpdateWorkspace,
  canUploadFile,
  resolveCollaborationAccess,
} from './policies';

const workspaceId = 'workspace_1';
const activeDocument = { id: 'document_1', workspaceId, archivedAt: null };
const archivedDocument = { id: 'document_2', workspaceId, archivedAt: new Date() };
const foreignDocument = { id: 'document_3', workspaceId: 'workspace_2', archivedAt: null };
const allRoles: WorkspaceRole[] = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'];

describe('workspace access', () => {
  it('denies non-members', () => {
    const decision = canReadWorkspace(null);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('workspace_access_denied');
  });

  it('allows every role to read', () => {
    for (const role of allRoles) {
      expect(canReadWorkspace(role).allowed).toBe(true);
    }
  });

  it('restricts member management to ADMIN and OWNER', () => {
    expect(canManageWorkspaceMembers('GUEST').allowed).toBe(false);
    expect(canManageWorkspaceMembers('MEMBER').allowed).toBe(false);
    expect(canManageWorkspaceMembers('ADMIN').allowed).toBe(true);
    expect(canManageWorkspaceMembers('OWNER').allowed).toBe(true);
  });

  it('restricts destructive workspace operations to OWNER', () => {
    expect(canPerformDestructiveWorkspaceOperation('ADMIN').allowed).toBe(false);
    expect(canPerformDestructiveWorkspaceOperation('OWNER').allowed).toBe(true);
  });

  it('restricts workspace settings (rename, slug) to ADMIN and OWNER', () => {
    expect(canUpdateWorkspace('GUEST').allowed).toBe(false);
    expect(canUpdateWorkspace('MEMBER').allowed).toBe(false);
    expect(canUpdateWorkspace('ADMIN').allowed).toBe(true);
    expect(canUpdateWorkspace('OWNER').allowed).toBe(true);
  });

  it('lets only owners grant ownership', () => {
    expect(canChangeMemberRole('ADMIN', 'MEMBER', 'OWNER', 1).allowed).toBe(false);
    expect(canChangeMemberRole('OWNER', 'MEMBER', 'OWNER', 1).allowed).toBe(true);
  });

  it('keeps at least one owner', () => {
    const decision = canChangeMemberRole('OWNER', 'OWNER', 'ADMIN', 1);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('conflict');
    expect(canChangeMemberRole('OWNER', 'OWNER', 'ADMIN', 2).allowed).toBe(true);
  });
});

describe('document policies', () => {
  it('rejects access to a document from another workspace', () => {
    const decision = canReadDocument('OWNER', foreignDocument, workspaceId);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_access_denied');
  });

  it('lets guests read but not create', () => {
    expect(canReadDocument('GUEST', activeDocument, workspaceId).allowed).toBe(true);
    expect(canCreateDocument('GUEST').allowed).toBe(false);
  });

  it('refuses editing an archived document', () => {
    const decision = canEditDocument('OWNER', archivedDocument);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_archived');
  });

  it('refuses archiving an already archived document', () => {
    expect(canArchiveDocument('OWNER', archivedDocument).allowed).toBe(false);
  });

  it('rejects a cross-workspace parent assignment', () => {
    const decision = canMoveDocument('OWNER', activeDocument, foreignDocument);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_cross_workspace');
  });

  it('rejects making a document its own parent', () => {
    const decision = canMoveDocument('OWNER', activeDocument, activeDocument);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_move_cycle');
  });

  it('rejects moving under an archived parent', () => {
    const decision = canMoveDocument('OWNER', activeDocument, archivedDocument);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_archived');
  });

  it('allows moving to the workspace root', () => {
    expect(canMoveDocument('MEMBER', activeDocument, null).allowed).toBe(true);
  });

  it('restricts snapshot restore to ADMIN and OWNER', () => {
    expect(canRestoreSnapshot('MEMBER', activeDocument).allowed).toBe(false);
    expect(canRestoreSnapshot('ADMIN', activeDocument).allowed).toBe(true);
  });
});

describe('cross-workspace move policy', () => {
  const otherWorkspaceId = 'workspace_2';

  it('requires edit rights in the source workspace first', () => {
    const decision = canMoveDocumentAcrossWorkspaces(
      'GUEST',
      activeDocument,
      'MEMBER',
      null,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('forbidden');
  });

  it('denies a mover who is not a member of the target workspace', () => {
    const decision = canMoveDocumentAcrossWorkspaces(
      'OWNER',
      activeDocument,
      null,
      null,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('workspace_access_denied');
  });

  it('requires at least MEMBER in the target workspace', () => {
    const decision = canMoveDocumentAcrossWorkspaces(
      'OWNER',
      activeDocument,
      'GUEST',
      null,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('forbidden');
  });

  it('rejects a target parent that does not belong to the target workspace', () => {
    const decision = canMoveDocumentAcrossWorkspaces(
      'OWNER',
      activeDocument,
      'MEMBER',
      activeDocument,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_cross_workspace');
  });

  it('rejects an archived target parent that does belong to the target workspace', () => {
    const targetParent = { ...archivedDocument, workspaceId: otherWorkspaceId };
    const decision = canMoveDocumentAcrossWorkspaces(
      'OWNER',
      activeDocument,
      'MEMBER',
      targetParent,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_archived');
  });

  it('allows the move to the target workspace root', () => {
    const decision = canMoveDocumentAcrossWorkspaces(
      'MEMBER',
      activeDocument,
      'MEMBER',
      null,
      otherWorkspaceId,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('database schema policy', () => {
  it('behaves exactly like canEditDocument', () => {
    for (const role of allRoles) {
      expect(canManageDatabaseSchema(role, activeDocument)).toEqual(canEditDocument(role, activeDocument));
      expect(canManageDatabaseSchema(role, archivedDocument)).toEqual(
        canEditDocument(role, archivedDocument),
      );
    }
    expect(canManageDatabaseSchema(null, activeDocument)).toEqual(canEditDocument(null, activeDocument));
  });

  it('denies changing an archived collection schema', () => {
    const decision = canManageDatabaseSchema('OWNER', archivedDocument);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('document_archived');
  });
});

describe('collaboration access resolution', () => {
  it('gives guests read-only access', () => {
    expect(resolveCollaborationAccess('GUEST', activeDocument)).toBe('read');
  });

  it('gives members write access', () => {
    expect(resolveCollaborationAccess('MEMBER', activeDocument)).toBe('write');
    expect(resolveCollaborationAccess('OWNER', activeDocument)).toBe('write');
  });

  it('downgrades archived documents to read-only for everyone', () => {
    for (const role of allRoles) {
      expect(resolveCollaborationAccess(role, archivedDocument)).toBe('read');
    }
  });

  it('refuses to issue a ticket for a foreign workspace document', () => {
    expect(canIssueCollaborationTicket('OWNER', foreignDocument, workspaceId).allowed).toBe(false);
  });
});

describe('attachment policies', () => {
  const attachment = {
    id: 'attachment_1',
    workspaceId,
    createdById: 'user_1',
    deletedAt: null,
  };

  it('allows members to upload but not guests', () => {
    expect(canUploadFile('MEMBER').allowed).toBe(true);
    expect(canUploadFile('GUEST').allowed).toBe(false);
  });

  it('denies download for non-members', () => {
    const decision = canDownloadAttachment(null, attachment, workspaceId);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('attachment_access_denied');
  });

  it('denies download across workspaces', () => {
    expect(canDownloadAttachment('OWNER', attachment, 'workspace_other').allowed).toBe(false);
  });

  it('treats a deleted attachment as not found', () => {
    const decision = canDownloadAttachment('OWNER', { ...attachment, deletedAt: new Date() }, workspaceId);
    expect(decision.allowed === false && decision.code).toBe('not_found');
  });

  it('lets the uploader delete their own attachment', () => {
    expect(canDeleteAttachment('MEMBER', attachment, 'user_1').allowed).toBe(true);
  });

  it('prevents another member from deleting a foreign attachment', () => {
    expect(canDeleteAttachment('MEMBER', attachment, 'user_2').allowed).toBe(false);
    expect(canDeleteAttachment('ADMIN', attachment, 'user_2').allowed).toBe(true);
  });

  it('lets a member correct extracted text or force a re-extraction, but not a guest', () => {
    expect(canEditAttachmentText('MEMBER', attachment, workspaceId).allowed).toBe(true);
    const decision = canEditAttachmentText('GUEST', attachment, workspaceId);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe('forbidden');
  });

  it('denies editing attachment text across workspaces, the same as download', () => {
    expect(canEditAttachmentText('OWNER', attachment, 'workspace_other').allowed).toBe(false);
  });
});

describe('realtime subscriptions', () => {
  it('requires membership', () => {
    expect(canSubscribeToWorkspaceRoom(null).allowed).toBe(false);
    expect(canSubscribeToWorkspaceRoom('GUEST').allowed).toBe(true);
  });
});
