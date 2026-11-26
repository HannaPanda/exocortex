import { type PrismaTransactionClient } from '@exocortex/database';
import {
  type WrittenBlock,
  writtenTopLevelBlocks,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';

/**
 * The blocks an agent's write changed, for the journal row that records it
 * (issue #248).
 *
 * Read inside the write's own transaction, after the content was updated and
 * before it commits, so "before" is the snapshot the write just took and
 * "after" is exactly what the write stored. Whatever an open editing session
 * does with the change a moment later is not this write's doing, and is what
 * an undo later compares against.
 *
 * `null` when either state does not derive into content: the row then says
 * "a write happened here, its blocks are unknown", and an undo leaves the page
 * alone rather than guessing at blocks it cannot name.
 */
export async function journalWrittenBlocks(
  tx: PrismaTransactionClient,
  documentId: string,
  snapshotBeforeId: string,
): Promise<WrittenBlock[] | null> {
  const [snapshot, content] = await Promise.all([
    tx.documentSnapshot.findUnique({
      where: { id: snapshotBeforeId },
      select: { yjsState: true },
    }),
    tx.documentContent.findUnique({ where: { documentId }, select: { yjsState: true } }),
  ]);
  if (snapshot === null || content === null) return null;
  try {
    return writtenTopLevelBlocks(
      yjsStateToProseMirrorJson(snapshot.yjsState),
      yjsStateToProseMirrorJson(content.yjsState),
    );
  } catch {
    return null;
  }
}
