import { assertPolicy, canManageWorkItems, type WorkspaceAccessService } from '@exocortex/auth';

import { AppError } from '../common/app-error';

/**
 * Who may move a piece of work along (issue #138, ADR-066).
 *
 * A MEMBER may do everything; the account the item is assigned to may,
 * whatever its role, record progress -- a status, a result, a note, a
 * checkpoint -- because being asked to do something has to include being
 * able to say how far it got. An item outside the caller's workspaces reads
 * as missing, so an id says nothing on its own.
 */
export async function assertMayProgress(
  access: WorkspaceAccessService,
  existing: { workspaceId: string; assigneeId: string | null },
  userId: string,
  /** True when the change only moves the work along. */
  progressOnly: boolean,
): Promise<void> {
  const role = await access.findRole(existing.workspaceId, userId);
  if (role === null) throw AppError.notFound('Work item');
  if (canManageWorkItems(role).allowed) return;
  if (existing.assigneeId === userId && progressOnly) return;
  assertPolicy(canManageWorkItems(role));
}
