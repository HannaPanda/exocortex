import { ATTACHMENT_SEARCH_TEXT_MAX_CHARS, type QUEUE_NAMES } from '@exocortex/contracts';
import {
  type PassageAnchor,
  type PrismaClient,
  type SearchAdapter,
  type SearchBlockMapUnit,
  type StoredSearchBlockMap,
  toStoredBlockMap,
} from '@exocortex/database';
import {
  blocksShowingAttachments,
  plainTextBlockMap,
  plainTextHeadingAnchors,
} from '@exocortex/editor';
import { type JobContext } from '@exocortex/queue';

import { asProseMirrorDocument } from './document-links';

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
    await reportProgress(10, 'indexing');

    const document = await prisma.document.findUnique({
      where: { id: payload.documentId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        archivedAt: true,
        parent: { select: { type: true } },
        content: { select: { plainText: true, proseMirrorJson: true } },
        attachments: {
          where: { deletedAt: null, textStatus: 'READY' },
          // Oldest first, so which attachments fit inside the budget below is
          // stable across runs rather than shuffling on every reindex.
          orderBy: { createdAt: 'asc' },
          select: { id: true, filename: true, extractedText: true, correctedText: true },
        },
      },
    });

    if (document === null) {
      await search.remove(payload.documentId);
      logger.info('Removed search projection for a deleted document', {
        documentId: payload.documentId,
      });
      await reportProgress(100, 'removed');
      return;
    }

    // A page without materialized content is still findable by its title.
    const pageText = document.content?.plainText ?? '';
    const attachments = collectAttachmentText(document.attachments);
    const attachmentText = attachments.text;
    const plainText = attachmentText.length === 0 ? pageText : `${pageText}\n\n${attachmentText}`;
    const blockMap = blockMapOf({
      proseMirrorJson: document.content?.proseMirrorJson,
      pageText,
      plainText,
      attachments,
    });
    if (blockMap.textDiffers) {
      logger.warn('Stored plain text differs from its JSON; page text left unlocated', {
        documentId: document.id,
      });
    }

    await search.index({
      documentId: document.id,
      workspaceId: document.workspaceId,
      title: document.title,
      plainText,
      archivedAt: document.archivedAt,
      ...(blockMap.map === undefined ? {} : { blockMap: blockMap.map }),
      isDatabaseRow: document.parent?.type === 'COLLECTION',
      headingAnchors: headingAnchorsOf(
        document.content?.proseMirrorJson,
        pageText,
        attachmentText.length > 0,
      ),
    });

    await reportProgress(100, 'done');
    logger.debug('Search projection updated', {
      documentId: document.id,
      reason: payload.reason,
      attachmentTextChars: attachmentText.length,
    });
  };
}

/**
 * The headings of the indexed text, so a semantic hit can name its section
 * (issue #118).
 *
 * Read off the stored ProseMirror JSON rather than off the canonical Yjs
 * state: indexing runs on every save, and deserializing a 2.9 million
 * character page for a list of headings would make it the expensive half of
 * the job. `undefined` when there is no materialized JSON yet, which is not
 * the same as a page without headings -- the passages then keep saying
 * nothing, and materialization enqueues another index shortly.
 *
 * Attachment text hangs behind the page text under no heading of the page, so
 * it gets the marker that ends the last section rather than being attributed
 * to it.
 */
function headingAnchorsOf(
  proseMirrorJson: unknown,
  pageText: string,
  hasAttachmentText: boolean,
): readonly PassageAnchor[] | undefined {
  const document = asProseMirrorDocument(proseMirrorJson);
  if (document === null) return undefined;
  const anchors: PassageAnchor[] = plainTextHeadingAnchors(document);
  if (hasAttachmentText) anchors.push({ offset: pageText.length, blockId: null, path: [] });
  return anchors;
}

interface AttachmentTextSegment {
  attachmentId: string;
  filename: string;
  /** Where this attachment's text starts in the joined attachment text. */
  offset: number;
}

/**
 * Which block every stretch of the indexed text came from (issue #280).
 *
 * Read off the stored ProseMirror JSON for the reason `headingAnchorsOf`
 * gives. The map is only trusted when the JSON renders to exactly the stored
 * plain text; when it does not, the page's own text stays unlocated rather
 * than located against a different version of the page, and the next
 * materialization indexes it again anyway. Attachment text is located by
 * file, at the block that shows it when there is one.
 *
 * `map` is absent when the page has text but no materialized JSON yet: that
 * is "still owed", which the backfill sweep and the next materialization
 * both come back for.
 */
function blockMapOf(input: {
  proseMirrorJson: unknown;
  pageText: string;
  plainText: string;
  attachments: { text: string; segments: readonly AttachmentTextSegment[] };
}): { map: StoredSearchBlockMap | undefined; textDiffers: boolean } {
  const document = asProseMirrorDocument(input.proseMirrorJson);
  if (document === null && input.pageText.length > 0) return { map: undefined, textDiffers: false };

  const page = document === null ? null : plainTextBlockMap(document);
  const textDiffers = page !== null && page.text !== input.pageText;
  const units: SearchBlockMapUnit[] =
    page === null || textDiffers
      ? []
      : page.units.map((unit) => ({
          offset: unit.offset,
          blockId: unit.blockId,
          heading: unit.heading < 0 ? null : unit.heading,
          attachment: null,
        }));

  const shown = document === null ? new Map<string, string>() : blocksShowingAttachments(document);
  const base = input.pageText.length + 2;
  input.attachments.segments.forEach((segment, index) => {
    units.push({
      offset: base + segment.offset,
      blockId: shown.get(segment.attachmentId) ?? null,
      heading: null,
      attachment: index,
    });
  });

  return {
    map: toStoredBlockMap({
      text: input.plainText,
      units,
      headings: page === null || textDiffers ? [] : page.headings,
      attachments: input.attachments.segments,
    }),
    textDiffers,
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
 * for the sake of symmetry. Where each file's text starts is kept, so a hit in
 * it can name the file (issue #280).
 */
function collectAttachmentText(
  attachments: readonly {
    id: string;
    filename: string;
    extractedText: string | null;
    correctedText: string | null;
  }[],
): { text: string; segments: AttachmentTextSegment[] } {
  const parts: string[] = [];
  const segments: AttachmentTextSegment[] = [];
  let at = 0;
  let remaining = ATTACHMENT_SEARCH_TEXT_MAX_CHARS;
  for (const attachment of attachments) {
    if (remaining <= 0) break;
    const text = attachment.correctedText ?? attachment.extractedText;
    if (text === null || text.length === 0) continue;
    const part = text.slice(0, remaining);
    segments.push({ attachmentId: attachment.id, filename: attachment.filename, offset: at });
    parts.push(part);
    at += part.length + 2;
    remaining -= Math.min(text.length, remaining);
  }
  return { text: parts.join('\n\n'), segments };
}
