import { type QUEUE_NAMES, QUEUE_NAMES as QUEUES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry } from '@exocortex/queue';

export interface MaintenanceDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  /** Snapshots kept per document by `prune-snapshots`. */
  snapshotsToKeep?: number;
  /** Outbox rows dispatched per run. */
  outboxBatchSize?: number;
}

/**
 * Maintenance processor.
 *
 * `dispatch-outbox` is the reliable half of the event system: the API writes
 * outbox rows inside the same transaction as the state change, and this job turns
 * them into follow-up work. Realtime delivery is the fast, best-effort half.
 */
export function createMaintenanceProcessor(dependencies: MaintenanceDependencies) {
  const { prisma, queues } = dependencies;
  const snapshotsToKeep = dependencies.snapshotsToKeep ?? 20;
  const outboxBatchSize = dependencies.outboxBatchSize ?? 100;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.maintenance>): Promise<void> => {
    switch (payload.task) {
      case 'dispatch-outbox': {
        const events = await prisma.outboxEvent.findMany({
          where: { processedAt: null },
          orderBy: { createdAt: 'asc' },
          take: outboxBatchSize,
        });
        if (events.length === 0) return;

        let dispatched = 0;
        for (const event of events) {
          try {
            const documentId = extractDocumentId(event.payload);
            if (documentId !== null && event.type.startsWith('document.')) {
              await queues.enqueue(QUEUES.searchIndexing, {
                correlationId: event.correlationId,
                documentId,
                workspaceId: event.workspaceId,
                reason: reasonFor(event.type),
              });
            }
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: { processedAt: new Date(), attempts: { increment: 1 } },
            });
            dispatched += 1;
          } catch (error) {
            // Record the failure and leave the row unprocessed for a later run;
            // it is never silently dropped.
            await prisma.outboxEvent.update({
              where: { id: event.id },
              data: {
                attempts: { increment: 1 },
                lastError: error instanceof Error ? error.message : String(error),
              },
            });
            logger.error('Failed to dispatch outbox event', error, {
              outboxEventId: event.id,
              type: event.type,
            });
          }
        }
        logger.debug('Outbox dispatched', { dispatched, batch: events.length });
        return;
      }

      case 'prune-snapshots': {
        await reportProgress(10, 'Alte Versionen werden aufgeräumt');
        const documents = await prisma.document.findMany({
          where: payload.workspaceId === null ? {} : { workspaceId: payload.workspaceId },
          select: { id: true },
        });
        let removed = 0;
        for (const document of documents) {
          const keep = await prisma.documentSnapshot.findMany({
            where: { documentId: document.id },
            orderBy: { createdAt: 'desc' },
            take: snapshotsToKeep,
            select: { id: true },
          });
          const result = await prisma.documentSnapshot.deleteMany({
            where: {
              documentId: document.id,
              id: { notIn: keep.map((snapshot) => snapshot.id) },
            },
          });
          removed += result.count;
        }
        await reportProgress(100, 'Versionen aufgeräumt');
        logger.info('Snapshots pruned', { removed, documents: documents.length });
        return;
      }

      case 'vacuum-search-index': {
        const orphans = await prisma.$executeRaw`
          DELETE FROM "document_search_index"
          WHERE "documentId" NOT IN (SELECT "id" FROM "document")
        `;
        logger.info('Search index vacuumed', { removed: orphans });
        return;
      }

      default: {
        // Exhaustiveness guard: a new task must be handled explicitly.
        const unhandled: never = payload.task;
        throw new Error(`Unhandled maintenance task: ${String(unhandled)}`);
      }
    }
  };
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
