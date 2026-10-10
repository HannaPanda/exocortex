import { assertPolicy, canManageWorkItems, type WorkspaceAccessService } from '@exocortex/auth';
import { AI_WRITE_MODES, type AiWriteMode } from '@exocortex/contracts';
import { agentProfileSnapshotSchema } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { currentAiRunId } from '../common/correlation';

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

/**
 * Choosing a work item's agent profile is loosening it as far as anybody can
 * tell (issue #143): one profile may allow what the other does not. So it
 * takes the credential that may loosen a write mode, a person or a token
 * that may write. The built-in AI cannot pick the rules it runs under.
 */
export function assertMayChooseProfile(mayLoosen: boolean): void {
  if (!mayLoosen) {
    throw AppError.forbidden('Only a person or a token that may write can choose an agent profile');
  }
}

/**
 * A run whose profile says a person closes the work (issue #143) may not set
 * it to `done`. Read from the run's own snapshot through the signed run id,
 * never from the request, so nothing the model sends can claim otherwise.
 * An item that is already done is left alone: the refusal is about closing.
 */
export async function assertRunMayClose(
  prisma: PrismaClient,
  currentStatus: string,
): Promise<void> {
  const runId = currentAiRunId();
  if (runId === undefined || currentStatus === 'DONE') return;
  const run = await prisma.aiRun.findUnique({
    where: { id: runId },
    select: { agentProfileSnapshot: true },
  });
  const snapshot = agentProfileSnapshotSchema.safeParse(run?.agentProfileSnapshot);
  if (snapshot.success && snapshot.data.approvalPolicy === 'review_before_done') {
    throw new AppError(
      'work_item_review_required',
      'This work is closed by a person; set it to review instead',
    );
  }
}
