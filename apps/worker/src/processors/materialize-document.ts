import { type MaterializeDocumentJob, QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { materializeYjsState } from '@exocortex/editor';
import { createCorrelationId } from '@exocortex/logger';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';

import { sweepCommentAnchors } from './comment-anchors';
import { replaceDocumentLinks } from './document-links';
import { extractEntities } from './entity-extraction';
import { materializeProject } from './materialize-project';

export interface MaterializationDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  bus: RedisEventBus;
  /** Runtime configuration (ADR-013). Read per job: the entity layer is a switch. */
  settings: (workspaceId?: string) => Promise<Settings>;
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
  const { prisma, queues, bus, settings } = dependencies;

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
        // Which of the two shapes the state has (issue #43, ADR-027). A
        // `PROJECT` document holds a file tree, and reading it as a ProseMirror
        // document would throw rather than produce nonsense.
        document: { select: { type: true } },
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

    if (content.document.type === 'PROJECT') {
      await reportProgress(30, 'Projektdateien werden ausgewertet');
      const materializedAt = new Date();
      const project = await materializeProject(prisma, {
        documentId: job.documentId,
        yjsState: content.yjsState,
        materializedAt,
      });
      await prisma.documentContent.update({
        where: { documentId: job.documentId },
        data: { materializedAt },
      });
      await bus.publish({
        type: 'project.files.changed',
        workspaceId: job.workspaceId,
        correlationId: job.correlationId,
        emittedAt: materializedAt.toISOString(),
        payload: { projectId: job.documentId, paths: project.paths },
      });
      await reportProgress(100, 'Projekt verarbeitet');
      logger.info('Project materialized', {
        documentId: job.documentId,
        textFiles: project.textFiles,
        assets: project.assets,
        reason: job.reason,
      });
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

    // References belong in this pass, not in a job of their own: they are
    // derived from the same content in the same way Markdown and the plain
    // text are, and one place that turns content into derived data is the
    // whole point of ADR-007.
    await reportProgress(85, 'Verweise werden erfasst');
    const linkCount = await replaceDocumentLinks(prisma, {
      documentId: job.documentId,
      workspaceId: job.workspaceId,
      proseMirrorJson: materialized.proseMirrorJson,
      indexedAt: materializedAt,
    });

    // Which entities the page talks about is derived from the same content, in
    // the same way (issue #47). Failing here must not fail the materialization:
    // the Markdown, the plain text and the references are already written, and
    // losing the entity edges of one save costs one save's worth of edges,
    // which the next one restores.
    let entityMentions = 0;
    try {
      const extracted = await extractEntities(prisma, {
        documentId: job.documentId,
        workspaceId: job.workspaceId,
        plainText: materialized.plainText,
        settings: await settings(),
        logger,
      });
      entityMentions = extracted.mentions;
    } catch (error) {
      logger.warn('Entity extraction failed', {
        documentId: job.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Anchored comments belong in this pass too: whether the block a thread
    // names still exists is derived from the same content. A deleted block
    // orphans its thread, it never removes it (issue #18).
    const commentAnchors = await sweepCommentAnchors(prisma, {
      documentId: job.documentId,
      proseMirrorJson: materialized.proseMirrorJson,
      sweptAt: materializedAt,
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
      linkCount,
      entityMentions,
      orphanedComments: commentAnchors.orphaned,
      restoredComments: commentAnchors.restored,
      reason: job.reason,
    });
  };
}

/** Correlation id used when the worker itself initiates work. */
export function workerCorrelationId(): string {
  return createCorrelationId();
}
