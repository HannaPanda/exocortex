import { QUEUE_NAMES as QUEUES } from '@exocortex/contracts';
import { type OutboxEvent, type PrismaClient } from '@exocortex/database';
import { withSpan } from '@exocortex/logger';

import { fireMatchingAutomations } from './automations';
import { isMissingRow, type MaintenanceTask } from './context';
import { scheduleOverviewRefreshes } from './overviews';

/**
 * Events after which a page may answer to a different title than before, so
 * every reference addressing the old or the new one has to be re-resolved.
 * An edit is deliberately not among them: editing a page changes what it
 * references, and that is rebuilt by materialization itself.
 */
const TITLE_EVENTS = new Set(['document.created', 'document.updated', 'document.moved']);

/**
 * Turns outbox rows into follow-up work.
 *
 * This is the reliable half of the event system: the API writes outbox rows
 * inside the same transaction as the state change (ADR-010), and realtime
 * delivery is the fast, best-effort half beside it.
 */
export const dispatchOutbox: MaintenanceTask = async (context) => {
  const { prisma, logger } = context;
  const events = await prisma.outboxEvent.findMany({
    where: { processedAt: null },
    orderBy: { createdAt: 'asc' },
    take: context.outboxBatchSize,
  });
  if (events.length === 0) return;

  let dispatched = 0;
  let vanished = 0;
  for (const event of events) {
    try {
      // One span per event, under the sweep's own job span (issue #57). The
      // sweep runs every five seconds and usually finds nothing; when it is
      // slow, this is what says which event type made it slow. The row itself
      // carries no trace context -- the request that wrote it is linked by its
      // correlation id, not by the trace.
      await withSpan(`outbox.dispatch ${event.type}`, async () => dispatchEvent(context, event), {
        correlationId: event.correlationId,
        attributes: {
          'exocortex.event.type': event.type,
          'exocortex.workspace_id': event.workspaceId,
        },
      });
      dispatched += 1;
    } catch (error) {
      // The batch is read once and worked through afterwards. A workspace
      // deleted in that window takes its outbox rows with it, so the row
      // this iteration is holding may no longer exist -- nothing failed,
      // there is simply nothing left to dispatch or to record against.
      if (isMissingRow(error)) {
        vanished += 1;
        continue;
      }
      logger.error('Failed to dispatch outbox event', error, {
        outboxEventId: event.id,
        type: event.type,
      });
      if (await recordOutboxFailure(prisma, event.id, error)) vanished += 1;
    }
  }
  logger.debug('Outbox dispatched', { dispatched, vanished, batch: events.length });
};

/** The follow-up work one outbox row stands for, and marking the row done. */
async function dispatchEvent(
  context: Parameters<MaintenanceTask>[0],
  event: OutboxEvent,
): Promise<void> {
  const { prisma, queues, logger } = context;
  const documentId = extractDocumentId(event.payload);
  if (documentId !== null && event.type.startsWith('document.')) {
    await queues.enqueue(QUEUES.searchIndexing, {
      correlationId: event.correlationId,
      documentId,
      workspaceId: event.workspaceId,
      reason: reasonFor(event.type),
    });
  }
  // A title-based reference index goes stale when a *target* page
  // appears or is renamed, not when the referencing page is edited,
  // so it has to be refreshed from this side too (issue #19). The
  // API only writes `document.updated` when the title actually
  // changed, which is what keeps this from firing on every save.
  if (documentId !== null && TITLE_EVENTS.has(event.type)) {
    await queues.enqueue(QUEUES.maintenance, {
      correlationId: event.correlationId,
      task: 'resolve-document-links',
      workspaceId: event.workspaceId,
      documentId,
    });
  }
  // Automations hang off the outbox for the same reason everything else
  // here does: this is the one place every domain event passes exactly
  // once (issue #50, ADR-024). A deployment with no rules pays for one
  // cached settings read per event and nothing more.
  await fireMatchingAutomations(
    {
      prisma,
      queues,
      logger,
      enabledFor: async (workspaceId) =>
        (await context.settings(workspaceId))['automations.enabled'],
    },
    {
      workspaceId: event.workspaceId,
      type: event.type,
      payload: event.payload,
      correlationId: event.correlationId,
      automationRuleId: event.automationRuleId,
      automationDepth: event.automationDepth,
    },
  );
  // Overview pages hang off the outbox for the same reason automations do
  // (issue #53, ADR-028): this is the one place a page change passes
  // exactly once. A workspace with no overview page pays for one cached
  // settings read per event.
  await scheduleOverviewRefreshes(
    {
      prisma,
      queues,
      enabledFor: async (workspaceId) => (await context.settings(workspaceId))['overview.enabled'],
      debounceSecondsFor: async (workspaceId) =>
        (await context.settings(workspaceId))['overview.debounceSeconds'],
    },
    {
      workspaceId: event.workspaceId,
      type: event.type,
      payload: event.payload,
      correlationId: event.correlationId,
    },
  );
  await prisma.outboxEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date(), attempts: { increment: 1 } },
  });
}

/**
 * Records a failed dispatch and leaves the row unprocessed for a later run; it
 * is never silently dropped.
 *
 * Returns true when the row itself disappeared while its failure was being
 * written: the same race as in the caller, one step later. Anything else is a
 * real fault and stays loud.
 */
async function recordOutboxFailure(
  prisma: PrismaClient,
  outboxEventId: string,
  error: unknown,
): Promise<boolean> {
  try {
    await prisma.outboxEvent.update({
      where: { id: outboxEventId },
      data: {
        attempts: { increment: 1 },
        lastError: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  } catch (recordingError) {
    if (!isMissingRow(recordingError)) throw recordingError;
    return true;
  }
}

function extractDocumentId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>).documentId;
  return typeof value === 'string' ? value : null;
}

function reasonFor(
  eventType: string,
): 'materialized' | 'title_changed' | 'archived' | 'restored' | 'deleted' | 'manual' {
  switch (eventType) {
    case 'document.archived':
      return 'archived';
    case 'document.restored':
      return 'restored';
    case 'document.materialized':
      return 'materialized';
    case 'document.created':
    case 'document.updated':
    case 'document.moved':
      return 'title_changed';
    default:
      return 'manual';
  }
}
