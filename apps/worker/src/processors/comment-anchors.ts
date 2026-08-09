import { type PrismaClient } from '@exocortex/database';
import { collectBlockIds, type ProseMirrorDocument } from '@exocortex/editor';

export interface CommentAnchorSweepResult {
  /** Threads whose anchored block has disappeared since the last pass. */
  orphaned: number;
  /** Threads whose block came back (an undo, a snapshot restore). */
  restored: number;
}

/**
 * Reconciles anchored comments with the blocks they name (issue #18).
 *
 * A comment anchors to a block identifier, and a block identifier is a claim
 * about a document that the document is free to invalidate: deleting the
 * paragraph deletes the anchor, not the remark. So this pass never deletes
 * anything. It records which threads have lost their block (`orphanedAt`), and
 * it clears that mark again when the block returns — an undo or a snapshot
 * restore brings the paragraph back, and the thread should stop apologising for
 * something that is no longer true.
 *
 * It runs inside materialization rather than in a job of its own for the same
 * reason the reference index does: it is derived from the content, in the same
 * pass that derives everything else from the content (ADR-007).
 */
export async function sweepCommentAnchors(
  prisma: PrismaClient,
  input: { documentId: string; proseMirrorJson: ProseMirrorDocument; sweptAt: Date },
): Promise<CommentAnchorSweepResult> {
  const anchored = await prisma.comment.findMany({
    where: { documentId: input.documentId, blockId: { not: null } },
    select: { id: true, blockId: true, orphanedAt: true },
  });
  if (anchored.length === 0) return { orphaned: 0, restored: 0 };

  // Reading the identifiers the document still carries, rather than asking the
  // database for each anchor: one walk of the JSON answers every comment.
  const present = new Set(collectBlockIds(input.proseMirrorJson));

  const toOrphan: string[] = [];
  const toRestore: string[] = [];
  for (const comment of anchored) {
    const alive = comment.blockId !== null && present.has(comment.blockId);
    if (!alive && comment.orphanedAt === null) toOrphan.push(comment.id);
    if (alive && comment.orphanedAt !== null) toRestore.push(comment.id);
  }

  if (toOrphan.length > 0) {
    await prisma.comment.updateMany({
      where: { id: { in: toOrphan } },
      data: { orphanedAt: input.sweptAt },
    });
  }
  if (toRestore.length > 0) {
    await prisma.comment.updateMany({
      where: { id: { in: toRestore } },
      data: { orphanedAt: null },
    });
  }

  return { orphaned: toOrphan.length, restored: toRestore.length };
}
