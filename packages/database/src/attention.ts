import { type Prisma, type PrismaClient, type PrismaTransactionClient } from './client';

/**
 * Raising attention items (issue #139, ADR-067), shared by the API and the
 * worker.
 *
 * Both raise items: the API when a work item enters a state that waits on a
 * person, the worker's sweep when a run behind a work item fails. The one rule
 * they must agree on is deduplication, so it lives here: every waiting state
 * has one key, and the partial unique index over open keys turns a second
 * raise for the same state into nothing rather than a second item.
 */

export type AttentionDraft = Omit<Prisma.AttentionItemCreateManyInput, 'id' | 'status'>;

/** The key of the one open item a waiting state may have. */
export const attentionDedupeKeys = {
  /** A work item in `review`, `blocked` or `waiting_for_human`. */
  workItemState: (workItemId: string, status: string): string =>
    `work-item:${workItemId}:${status}`,
  /** A failed run behind a work item. */
  runFailed: (runId: string): string => `run-failed:${runId}`,
  /** An explicit request, idempotent per asker and their own key. */
  request: (workspaceId: string, askerId: string, key: string): string =>
    `request:${workspaceId}:${askerId}:${key}`,
} as const;

/**
 * Inserts the drafts whose key is not already open and returns the ids of the
 * rows it created. A draft without a key is always inserted.
 */
export async function raiseAttentionItems(
  client: PrismaClient | PrismaTransactionClient,
  drafts: readonly AttentionDraft[],
): Promise<string[]> {
  if (drafts.length === 0) return [];
  const created = await client.attentionItem.createManyAndReturn({
    data: drafts.map((draft) => ({ ...draft, status: 'OPEN' as const })),
    // ON CONFLICT DO NOTHING without a target: the partial unique index over
    // open keys is the conflict, and a skipped row is the deduplication.
    skipDuplicates: true,
    select: { id: true },
  });
  return created.map((row) => row.id);
}
