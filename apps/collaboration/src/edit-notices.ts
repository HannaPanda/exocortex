import { type Hocuspocus } from '@hocuspocus/server';
import type * as Y from 'yjs';

import {
  agentDisplayName,
  type BlockRangeEdit,
  type CollaborationEditActor,
  type CollaborationEditNotice,
  EDIT_NOTICE_MAX_BLOCKS,
  EDIT_NOTICE_TYPE,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  changedBlockIds,
  type ProseMirrorDocument,
  yDocToProseMirrorJson,
} from '@exocortex/editor';

/**
 * Edit notices (issue #112): what the people with a page open are told when a
 * write that did not come from the editor changed it.
 *
 * Everything here is best effort by design. A notice is a highlight, never
 * information the reader would otherwise lack -- the change itself has
 * already arrived through Yjs -- so nothing in this file may fail the write it
 * describes: a derivation that throws or a name that cannot be looked up costs
 * the notice or the name, and the write goes on.
 */

export interface EditNoticeTarget {
  instance: Hocuspocus;
  prisma: PrismaClient;
  documentId: string;
  actor: CollaborationEditActor;
  /** The account the service token was minted for. */
  userId: string;
}

/**
 * The page as it stands before the write, or `null` when nobody has it open.
 *
 * Only read while somebody is watching: the notice is for them, and without
 * them the two derivations would be work for nobody.
 */
export function captureBeforeEdit(target: EditNoticeTarget): ProseMirrorDocument | null {
  const live = target.instance.documents.get(target.documentId);
  if ((live?.getConnectionsCount() ?? 0) === 0) return null;
  return readLive(live);
}

/**
 * Names the blocks that differ from `before`. Called after the store, so the
 * update the notice describes has already gone down the same socket ahead of
 * it.
 */
export async function announceChange(
  target: EditNoticeTarget,
  before: ProseMirrorDocument | null,
): Promise<void> {
  if (before === null) return;
  const after = readLive(target.instance.documents.get(target.documentId));
  if (after === null) return;
  const blockIds = changedBlockIds(before, after, EDIT_NOTICE_MAX_BLOCKS);
  if (blockIds.length === 0) return;
  broadcast(target, {
    type: EDIT_NOTICE_TYPE,
    outcome: 'changed',
    actorKind: target.actor.kind,
    actorName: await actorName(target),
    blockIds,
  });
}

/**
 * Tells the readers that a narrow write aimed at these blocks was refused, so
 * they see a refusal there rather than nothing -- or, worse, read the next
 * change as this one. A whole-page write names no blocks, so it has nowhere to
 * point and stays silent.
 */
export async function announceRefusal(
  target: EditNoticeTarget,
  edit: BlockRangeEdit | null,
): Promise<void> {
  if (edit === null) return;
  const live = target.instance.documents.get(target.documentId);
  if ((live?.getConnectionsCount() ?? 0) === 0) return;
  broadcast(target, {
    type: EDIT_NOTICE_TYPE,
    outcome: 'failed',
    actorKind: target.actor.kind,
    actorName: await actorName(target),
    blockIds: [edit.fromBlockId, ...(edit.toBlockId === null ? [] : [edit.toBlockId])],
  });
}

/**
 * Sends a notice to every connection on the document. Read-only connections
 * get it too: a reader is exactly the person who would otherwise watch a
 * paragraph change with no explanation.
 */
function broadcast(target: EditNoticeTarget, notice: CollaborationEditNotice): void {
  target.instance.documents.get(target.documentId)?.broadcastStateless(JSON.stringify(notice));
}

/** The live document as ProseMirror JSON, or `null` when it cannot be derived. */
function readLive(document: Y.Doc | undefined): ProseMirrorDocument | null {
  if (document === undefined) return null;
  try {
    return yDocToProseMirrorJson(document);
  } catch {
    return null;
  }
}

/**
 * What the open editors call the writer: an agent by its own label, a person
 * by their account name. The editor has its own word for somebody it cannot
 * name.
 */
async function actorName(target: EditNoticeTarget): Promise<string | null> {
  if (target.actor.kind === 'agent') return agentDisplayName(target.actor.label);
  try {
    const user = await target.prisma.user.findUnique({
      where: { id: target.userId },
      select: { name: true },
    });
    return user?.name ?? null;
  } catch {
    return null;
  }
}
