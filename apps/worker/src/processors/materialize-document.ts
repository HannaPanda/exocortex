import { type MaterializeDocumentJob, QUEUE_NAMES } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { materializeYjsState } from '@exocortex/editor';
import { createCorrelationId } from '@exocortex/logger';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';

export interface MaterializationDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  bus: RedisEventBus;
}

/**
 * Derives every non-canonical representation of a document from its binary Yjs
 * state.
 *
 * Idempotency: the job compares the stored `yjsUpdatedAt` with `materializedAt`
 * and skips work when the derived data is already at least as fresh. Running the
 * same job twice therefore has no additional effect, which is what makes the
 * debounced enqueue safe.
 */
export function createMaterializeDocumentProcessor(dependencies: MaterializationDependencies) {
  const { prisma, queues, bus } = dependencies;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.documentMaterialization>): Promise<void> => {
    const job: MaterializeDocumentJob = payload;
    await reportProgress(5, 'Seite wird geladen');

    const content = await prisma.documentContent.findUnique({
      where: { documentId: job.documentId },
      select: {
        yjsState: true,
        yjsUpdatedAt: true,
        materializedAt: true,
        schemaVersion: true,
      },
    });

    if (content === null) {
      logger.warn('Skipping materialization: no content row', { documentId: job.documentId });
      return;
    }

    if (
      content.materializedAt !== null &&
      content.materializedAt.getTime() >= content.yjsUpdatedAt.getTime()
    ) {
      logger.debug('Skipping materialization: derived data already current', {
        documentId: job.documentId,
      });
      await reportProgress(100, 'Bereits aktuell');
      return;
    }

    await reportProgress(30, 'Inhalt wird ausgewertet');
    const materialized = materializeYjsState(content.yjsState);

    await reportProgress(70, 'Abgeleitete Daten werden gespeichert');
    const materializedAt = new Date();
    await prisma.documentContent.update({
      where: { documentId: job.documentId },
      data: {
        proseMirrorJson: materialized.proseMirrorJson as unknown as Prisma.InputJsonObject,
        plainText: materialized.plainText,
        markdown: materialized.markdown,
        schemaVersion: materialized.schemaVersion,
        materializedAt,
      },
    });

    // Search indexing is a separate, retryable step.
    await queues.enqueue(QUEUE_NAMES.searchIndexing, {
      correlationId: job.correlationId,
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      reason: 'materialized',
    });

    await bus.publish({
      type: 'document.materialized',
      workspaceId: job.workspaceId,
      correlationId: job.correlationId,
      emittedAt: materializedAt.toISOString(),
      payload: {
        documentId: job.documentId,
        schemaVersion: materialized.schemaVersion,
        materializedAt: materializedAt.toISOString(),
        plainTextLength: materialized.plainText.length,
      },
    });

    await reportProgress(100, 'Seite verarbeitet');
    logger.info('Document materialized', {
      documentId: job.documentId,
      plainTextLength: materialized.plainText.length,
      reason: job.reason,
    });
  };
}

/** Correlation id used when the worker itself initiates work. */
export function workerCorrelationId(): string {
  return createCorrelationId();
}
