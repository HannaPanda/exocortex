import { type PrismaTransactionClient } from '@exocortex/database';
import {
  pageFingerprint,
  type WrittenBlock,
  writtenTopLevelBlocks,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';

/**
 * What a rename or a move changed, kept on the journal row beside it
 * (issue #248). Ids and titles, never content (ADR-022): enough for an undo
 * to put the page back, and to see whether it is still where the run left it.
 */
export type AgentWriteStructure =
  | { kind: 'renamed'; from: string; to: string }
  | {
      kind: 'moved';
      fromParentId: string | null;
      toParentId: string | null;
      fromWorkspaceId: string;
      toWorkspaceId: string;
      fromOrderKey: string;
      toOrderKey: string;
    };

/** What the journal row of one write keeps about the page's content. */
export interface JournalledContent {
  /** The blocks the write changed; `null` without a snapshot or when a state did not derive. */
  blocks: WrittenBlock[] | null;
  /** One fingerprint of the whole page as the write left it; `null` when it did not derive. */
  pageAfter: string | null;
}

/**
 * The blocks an agent's write changed, and the page as it left it, for the
 * journal row that records it (issue #248).
 *
 * Read inside the write's own transaction, after the content was updated and
 * before it commits, so "before" is the snapshot the write just took and
 * "after" is exactly what the write stored. Whatever an open editing session
 * does with the change a moment later is not this write's doing, and is what
 * an undo later compares against.
 *
 * `blocks` is `null` when either state does not derive into content: the row
 * then says "a write happened here, its blocks are unknown", and an undo
 * leaves the page alone rather than guessing at blocks it cannot name. A
 * write without a snapshot (a page created with its content) still records
 * `pageAfter`, which is all an undo of a new page needs.
 */
export async function journalContent(
  tx: PrismaTransactionClient,
  documentId: string,
  snapshotBeforeId: string | undefined,
): Promise<JournalledContent> {
  const [snapshot, content] = await Promise.all([
    snapshotBeforeId === undefined
      ? null
      : tx.documentSnapshot.findUnique({
          where: { id: snapshotBeforeId },
          select: { yjsState: true },
        }),
    tx.documentContent.findUnique({ where: { documentId }, select: { yjsState: true } }),
  ]);
  if (content === null) return { blocks: null, pageAfter: null };
  let after;
  try {
    after = yjsStateToProseMirrorJson(content.yjsState);
  } catch {
    return { blocks: null, pageAfter: null };
  }
  const pageAfter = pageFingerprint(after);
  if (snapshot === null) return { blocks: null, pageAfter };
  try {
    return {
      blocks: writtenTopLevelBlocks(yjsStateToProseMirrorJson(snapshot.yjsState), after),
      pageAfter,
    };
  } catch {
    return { blocks: null, pageAfter };
  }
}
