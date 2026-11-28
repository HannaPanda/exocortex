import { assertPolicy, canUploadFile, type WorkspaceAccessService } from '@exocortex/auth';

/**
 * Whether the caller may put a file onto this page: the one question the
 * upload, the upload from an address, an upload ticket and a cover all ask, so
 * the four can never disagree.
 *
 * Anchored at the page the file lands on (issue #83, ADR-044): a file that
 * hangs on a page takes that page's access, so a credential confined to a
 * branch may upload into it and a file that hangs on nothing is a
 * workspace-level act and refused for such a credential. A file on the page
 * itself is part of the page, so any grant covering the page carries it,
 * `PAGE_ONLY` included (issue #264). A file for a database cell stays with the
 * branch: the row is a page of its own below the database, and a grant on the
 * database alone does not reach it (ADR-098).
 */
export async function requireUploadRole(
  access: WorkspaceAccessService,
  input: {
    workspaceId: string;
    userId: string;
    documentId: string | null;
    propertyId?: string | null;
  },
): Promise<void> {
  const role =
    (input.propertyId ?? null) === null
      ? await access.requireRoleOnPage(input.workspaceId, input.userId, input.documentId)
      : await access.requireRoleAnchoredAt(input.workspaceId, input.userId, input.documentId);
  assertPolicy(canUploadFile(role));
}
