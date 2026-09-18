import { semanticSearchOptions } from '@exocortex/contracts';
import { CHUNK_THRESHOLD_CHARS, Prisma } from '@exocortex/database';

import { type MaintenanceTask } from './context';

/**
 * How long one `backfill-embeddings` run may keep working. Long enough that a
 * first fill of a large workspace is minutes rather than hours, short enough
 * that the shared maintenance queue is never held for a noticeable time.
 */
const EMBEDDING_BACKFILL_RUN_MS = 30_000;

/** Drops index rows whose page no longer exists. */
export const vacuumSearchIndex: MaintenanceTask = async ({ prisma, logger }) => {
  const orphans = await prisma.$executeRaw`
    DELETE FROM "document_search_index"
    WHERE "documentId" NOT IN (SELECT "id" FROM "document")
  `;
  logger.info('Search index vacuumed', { removed: orphans });
};

/** Fills in vectors for the pages the semantic index has never seen. */
export const backfillEmbeddings: MaintenanceTask = async (context) => {
  const { prisma, search, payload, logger, reportProgress } = context;
  const settings = await context.settings();
  const semantic = semanticSearchOptions(settings);
  if (semantic === null) return;

  // Pages the vector index has never seen under the model that is
  // currently configured, plus the long ones that have a whole-document
  // vector but none of the passages issue #36 added: turning chunking on
  // is the same kind of catching up as turning semantic search on, and
  // nothing else would ever revisit a page that is not being edited.
  // Newest first: a deployment that has just switched semantic search on
  // gets the pages it is working on today long before the ones it has not
  // touched in a year.
  const scope =
    payload.workspaceId === null
      ? Prisma.empty
      : Prisma.sql`AND index."workspaceId" = ${payload.workspaceId}`;
  const readBatch = async (): Promise<
    {
      documentId: string;
      workspaceId: string;
      title: string;
      plainText: string;
      archivedAt: Date | null;
    }[]
  > =>
    prisma.$queryRaw(Prisma.sql`
      SELECT
        index."documentId"  AS "documentId",
        index."workspaceId" AS "workspaceId",
        index."title"       AS "title",
        index."plainText"   AS "plainText",
        index."archivedAt"  AS "archivedAt"
      FROM "document_search_index" AS index
      LEFT JOIN "document_embedding" AS embedding
        ON embedding."documentId" = index."documentId"
       AND embedding."blockId" IS NULL
       AND embedding."model" = ${semantic.model}
      WHERE (
          embedding."id" IS NULL
          OR (
            length(index."plainText") > ${CHUNK_THRESHOLD_CHARS}
            AND NOT EXISTS (
              SELECT 1 FROM "document_embedding" AS passage
              WHERE passage."documentId" = index."documentId"
                AND passage."blockId" IS NOT NULL
                AND passage."model" = ${semantic.model}
            )
          )
        )
        ${scope}
      ORDER BY index."updatedAt" DESC
      LIMIT ${context.embeddingBackfillBatchSize}
    `);

  /**
   * Several batches per run, bounded by time rather than by count.
   *
   * A first fill is thousands of pages, and one batch every two minutes
   * would take hours; a fixed higher count would instead hold the
   * maintenance queue for however long the provider happens to be slow.
   * The budget keeps both ends honest, and the sweep is a no-op once
   * every page has a vector.
   */
  const deadline = Date.now() + EMBEDDING_BACKFILL_RUN_MS;
  let embedded = 0;
  let seen = 0;
  let progressed = false;
  while (Date.now() < deadline) {
    const pending = await readBatch();
    if (pending.length === 0) break;
    if (!progressed) {
      await reportProgress(10, 'Bedeutungen werden nachgetragen');
      progressed = true;
    }
    seen += pending.length;
    try {
      const written = await search.writeEmbeddings(pending, semantic.model);
      embedded += written;
      if (written === 0) {
        // The batch is owed work that writing does not settle -- a page of
        // nothing but blank lines is long enough to be cut up and has no
        // passage to cut. The same batch would come back for the rest of the
        // run, so the run ends here instead of spinning on it.
        logger.warn('A batch of embeddings settled nothing, ending the run', {
          batch: pending.length,
          documentId: pending[0]?.documentId,
        });
        break;
      }
    } catch (error) {
      // A batch the model refuses (a rate limit, a page too long even
      // after truncation) must not fail the job into a retry loop.
      // Nothing was written for it, so the next run sees it again.
      logger.warn('Could not backfill a batch of embeddings', {
        batch: pending.length,
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  if (!progressed) return;

  await reportProgress(100, 'Bedeutungen nachgetragen');
  logger.info('Embeddings backfilled', { embedded, seen, model: semantic.model });
};
