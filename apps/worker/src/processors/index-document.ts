import { type QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient, type SearchAdapter } from '@exocortex/database';
import { type JobContext } from '@exocortex/queue';

export interface IndexingDependencies {
  prisma: PrismaClient;
  search: SearchAdapter;
}

/**
 * Keeps the search projection in sync with a document.
 *
 * Idempotent by construction: the projection is a full upsert of the current
 * state, so replaying the job produces the same row. Deleted documents remove
 * their projection.
 */
export function createIndexDocumentProcessor(dependencies: IndexingDependencies) {
  const { prisma, search } = dependencies;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.searchIndexing>): Promise<void> => {
    await reportProgress(10, 'Suchindex wird aktualisiert');

    const document = await prisma.document.findUnique({
      where: { id: payload.documentId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        archivedAt: true,
        content: { select: { plainText: true } },
      },
    });

    if (document === null) {
      await search.remove(payload.documentId);
      logger.info('Removed search projection for a deleted document', {
        documentId: payload.documentId,
      });
      await reportProgress(100, 'Suchindex bereinigt');
      return;
    }

    await search.index({
      documentId: document.id,
      workspaceId: document.workspaceId,
      title: document.title,
      // A page without materialized content is still findable by its title.
      plainText: document.content?.plainText ?? '',
      archivedAt: document.archivedAt,
    });

    await reportProgress(100, 'Suchindex aktualisiert');
    logger.debug('Search projection updated', {
      documentId: document.id,
      reason: payload.reason,
    });
  };
}
