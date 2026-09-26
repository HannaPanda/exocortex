import { assertPolicy, canManageWorkItems, type WorkspaceAccessService } from '@exocortex/auth';
import { AI_WRITE_MODES, type AiWriteMode } from '@exocortex/contracts';

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

/**
 * A work item's write mode may be tightened by anybody who may change the
 * item, and loosened only by a credential that could write itself: a person,
 * or a token with the `write` scope (issue #141). Neither the built-in AI nor
 * a proposing agent can lift the mode it is held to, which is what makes the
 * mode a boundary rather than a suggestion. Null counts as `direct` here,
 * because inheriting may well mean inheriting `direct`.
 */
export function assertWriteModeChange(
  current: 'READ_ONLY' | 'PROPOSE' | 'DIRECT' | null,
  next: AiWriteMode | null | undefined,
  mayLoosen: boolean,
): void {
  if (next === undefined || mayLoosen) return;
  const rank = (mode: AiWriteMode | null) => AI_WRITE_MODES.indexOf(mode ?? 'direct');
  const now = current === null ? null : (current.toLowerCase() as AiWriteMode);
  if (rank(next) > rank(now)) {
    throw AppError.forbidden('Only a person or a token that may write can loosen the write mode');
  }
}
