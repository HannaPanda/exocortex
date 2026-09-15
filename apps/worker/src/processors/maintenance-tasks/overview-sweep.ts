import { QUEUE_NAMES } from '@exocortex/contracts';
import { createCorrelationId } from '@exocortex/logger';

import { type MaintenanceTask } from './context';

/** Overview pages handed back per run. A net, not a rebuild. */
const BATCH_SIZE = 50;
/** Candidates looked at per run before the batch is picked from them. */
const CANDIDATE_LIMIT = 500;

/**
 * Hands overview pages whose composition may be behind back to the queue
 * (issue #53, ADR-028).
 *
 * The same net `rematerialize-stale-content` is under materialization, and it
 * exists for the same reason: a refresh is enqueued by whoever changed a page,
 * and that enqueue can be lost in silence -- a debounce id that was still
 * taken, a flushed Redis, a job that exhausted its retries. There is one case
 * no event can reach at all: a permanently deleted page takes its `parentId`
 * with it, so the overview above it never hears that a child is gone.
 *
 * Nothing is composed here and nothing is compared here. The job's own hash
 * check is the authority on whether there is work, and a page that is current
 * costs one page read and one child read when its job runs.
 */
export const refreshStaleOverviews: MaintenanceTask = async (context) => {
  const { prisma, queues, payload, logger } = context;

  const candidates = await prisma.document.findMany({
    where: {
      overviewMode: 'AUTO',
      archivedAt: null,
      ...(payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId }),
    },
    select: { id: true, workspaceId: true, digest: { select: { introAt: true } } },
    take: CANDIDATE_LIMIT,
  });
  if (candidates.length === 0) return;

  // A page that has never been composed goes first: it is showing a bare list
  // to somebody right now. After that the oldest composition, so a deployment
  // with more overview pages than one batch rotates through them instead of
  // asking about the same fifty every hour.
  const ordered = [...candidates].sort(
    (left, right) =>
      (left.digest?.introAt?.getTime() ?? 0) - (right.digest?.introAt?.getTime() ?? 0),
  );

  const batch = ordered.slice(0, BATCH_SIZE);
  for (const row of batch) {
    await queues.enqueue(QUEUE_NAMES.documentOverview, {
      correlationId: createCorrelationId(),
      documentId: row.id,
      workspaceId: row.workspaceId,
      reason: 'sweep',
      force: false,
      depth: 0,
    });
  }
  logger.debug('Overview pages handed back for a refresh', {
    documents: batch.length,
    candidates: candidates.length,
    workspaceId: payload.workspaceId ?? undefined,
  });
};
