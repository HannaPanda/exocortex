import { ATTACHMENT_SEARCH_TEXT_MAX_CHARS, type QUEUE_NAMES } from '@exocortex/contracts';
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
        attachments: {
          where: { deletedAt: null, textStatus: 'READY' },
          // Oldest first, so which attachments fit inside the budget below is
          // stable across runs rather than shuffling on every reindex.
          orderBy: { createdAt: 'asc' },
          select: { extractedText: true, correctedText: true },
        },
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

    // A page without materialized content is still findable by its title.
    const pageText = document.content?.plainText ?? '';
    const attachmentText = collectAttachmentText(document.attachments);

    await search.index({
      documentId: document.id,
      workspaceId: document.workspaceId,
      title: document.title,
      plainText: attachmentText.length === 0 ? pageText : `${pageText}\n\n${attachmentText}`,
      archivedAt: document.archivedAt,
    });

    await reportProgress(100, 'Suchindex aktualisiert');
    logger.debug('Search projection updated', {
      documentId: document.id,
      reason: payload.reason,
      attachmentTextChars: attachmentText.length,
    });
  };
}

/**
 * The text of a page's attachments, as the search projection carries it
 * (issue #101).
 *
 * Until now the projection held only what was written on the page, so a PDF
 * could be found by its file name and by nothing inside it -- although the text
 * had been extracted, stored and served to the AI for over a month. This is the
 * missing half: what a person can read in an attachment, they can now search
 * for.
 *
 * The human correction wins over the machine result, the same order every other
 * reader uses: somebody who fixed a garbled scan fixed it for the search too.
 * The budget is shared and spent oldest first rather than divided per
 * attachment, so one long PDF beside three short ones is not cut to a quarter
 * for the sake of symmetry.
 */
function collectAttachmentText(
  attachments: readonly { extractedText: string | null; correctedText: string | null }[],
): string {
  const parts: string[] = [];
  let remaining = ATTACHMENT_SEARCH_TEXT_MAX_CHARS;
  for (const attachment of attachments) {
    if (remaining <= 0) break;
    const text = attachment.correctedText ?? attachment.extractedText;
    if (text === null || text.length === 0) continue;
    parts.push(text.slice(0, remaining));
    remaining -= Math.min(text.length, remaining);
  }
  return parts.join('\n\n');
}
