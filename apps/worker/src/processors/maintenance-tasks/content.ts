import { QUEUE_NAMES } from '@exocortex/contracts';
import { createCorrelationId } from '@exocortex/logger';

import { type MaintenanceTask } from './context';

/**
 * Content rows handed back per run.
 *
 * Small on purpose: this is a safety net, not a rebuild. A deployment that
 * somehow lost a thousand enqueues fills in over a few hours instead of putting
 * a thousand jobs into the queue at once, next to the ones people are waiting
 * for.
 */
const BATCH_SIZE = 100;

/**
 * Re-materializes every page whose derived data is behind its canonical state.
 *
 * `yjsState` is the truth (ADR-005); `proseMirrorJson`, `plainText`, `markdown`,
 * the reference index and the comment anchors are derived from it by the
 * materialization job, which is enqueued by whoever wrote the state. That
 * enqueue is the weak link: a debounce id that was still taken, a Redis that
 * was flushed, a job that exhausted its retries. Nothing was watching, so a
 * page could keep a stale projection for ever -- and the search index and the
 * built-in AI's page context read the projection, not the state.
 *
 * `materializedAt < yjsUpdatedAt` is exactly that condition, and the
 * materialization job compares the same two timestamps before it does any work:
 * a row that has caught up in the meantime costs one query and nothing else.
 */
export const rematerializeStaleContent: MaintenanceTask = async (context) => {
  const { prisma, queues, payload, logger, reportProgress } = context;

  const stale = await prisma.documentContent.findMany({
    where: {
      OR: [
        // Never materialized at all: a page created and never edited, and the
        // rows a failed enqueue left behind.
        { materializedAt: null },
        { materializedAt: { lt: prisma.documentContent.fields.yjsUpdatedAt } },
      ],
      ...(payload.workspaceId === null ? {} : { document: { workspaceId: payload.workspaceId } }),
    },
    select: {
      documentId: true,
      yjsUpdatedAt: true,
      document: { select: { workspaceId: true } },
    },
    // Oldest first, so a backlog is worked off in the order it accumulated.
    orderBy: { yjsUpdatedAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (stale.length === 0) return;

  await reportProgress(10, 'rematerializing');
  for (const row of stale) {
    await queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: createCorrelationId(),
      documentId: row.documentId,
      workspaceId: row.document.workspaceId,
      yjsUpdatedAt: row.yjsUpdatedAt.getTime(),
      reason: 'manual',
    });
  }
  await reportProgress(100, 'done');
  // At info: a number that stays above zero run after run means the jobs are
  // being enqueued and are not finishing, which no other line would show.
  logger.info('Stale content handed back to materialization', {
    documents: stale.length,
    workspaceId: payload.workspaceId ?? undefined,
  });
};
