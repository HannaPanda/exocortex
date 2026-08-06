import { type PdfTextExtractor } from '@exocortex/ai';
import { type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type JobContext } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

/** Extracted text is capped here; a 400k character page is already enormous context. */
const MAX_EXTRACTED_TEXT_CHARS = 400_000;

export interface AttachmentTextDependencies {
  prisma: PrismaClient;
  storage: ObjectStorage;
  /**
   * Engines to try in order, derived from the current settings. Empty when
   * nothing is configured (D6's "unconfigured" seam).
   *
   * The order is what turns a scanned PDF from a dead end into a result: the
   * OpenRouter engine returns nothing for a scan, and Docling behind it reads
   * the same file through OCR.
   */
  extractors: (settings: Settings) => readonly PdfTextExtractor[];
  settings: () => Promise<Settings>;
}

/**
 * Extracts and caches the text layer of a PDF attachment (D6).
 *
 * Idempotent, following `materialize-document.ts`: a `READY` attachment is
 * never re-extracted, even by a retried job. `exo_attachment_read_text` (the
 * MCP/AI-facing read path) never extracts on its own -- it only reads this
 * cache or reports `pending`, which is what keeps that surface fast and
 * Redis-free.
 */
export function createAttachmentTextProcessor(dependencies: AttachmentTextDependencies) {
  const { prisma, storage } = dependencies;

  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.attachmentText>): Promise<void> => {
    const attachment = await prisma.attachment.findUnique({ where: { id: payload.attachmentId } });
    if (attachment === null || attachment.deletedAt !== null) {
      logger.info('Skipping attachment text extraction: attachment missing or deleted', {
        attachmentId: payload.attachmentId,
      });
      return;
    }

    if (attachment.textStatus === 'READY') {
      // Idempotency: a retried job must not re-extract.
      logger.info('Skipping attachment text extraction: already ready', { attachmentId: attachment.id });
      return;
    }

    const settings = await dependencies.settings();

    const extractors = dependencies.extractors(settings);

    if (extractors.length === 0 || !settings['ai.pdfExtractionEnabled']) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { textStatus: 'FAILED', textExtractionError: 'PDF extraction is not configured' },
      });
      logger.info('Attachment text extraction unavailable', { attachmentId: attachment.id });
      return;
    }

    if (attachment.mimeType !== 'application/pdf') {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { textStatus: 'NOT_APPLICABLE' },
      });
      return;
    }

    if (attachment.byteSize > settings['ai.pdfMaxBytes']) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          textStatus: 'FAILED',
          textExtractionError: `PDF exceeds the configured size limit (${attachment.byteSize} > ${settings['ai.pdfMaxBytes']} bytes)`,
        },
      });
      logger.info('Skipping attachment text extraction: PDF too large', {
        attachmentId: attachment.id,
        byteSize: attachment.byteSize,
      });
      return;
    }

    // Deterministic outcomes above are handled explicitly; anything below this
    // point (a network error, a storage read failure) is left to bubble so
    // BullMQ applies the configured retry policy -- FAILED is reserved for
    // outcomes that will not change on retry.
    const stream = await storage.getObject({ key: attachment.storageKey });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const data = Buffer.concat(chunks);

    // Each engine gets the whole document. A `null` means "this engine found
    // nothing", which is a routine outcome for a scan hitting a text-only
    // engine, so the next one in the chain is tried before giving up. A thrown
    // error still bubbles: an unreachable Docling container must be retried,
    // not silently downgraded to a worse result.
    let extraction = null as Awaited<ReturnType<PdfTextExtractor['extract']>>;
    for (const candidate of extractors) {
      extraction = await candidate.extract({
        data,
        filename: attachment.filename,
        correlationId: payload.correlationId,
      });
      if (extraction !== null) break;
    }

    if (extraction === null) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { textStatus: 'FAILED', textExtractionError: 'No extractable text layer' },
      });
      logger.info('PDF has no extractable text layer', {
        attachmentId: attachment.id,
        enginesTried: extractors.length,
      });
      return;
    }

    await prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        textStatus: 'READY',
        extractedText: extraction.text.slice(0, MAX_EXTRACTED_TEXT_CHARS),
        textExtractedAt: new Date(),
        textExtractionError: null,
      },
    });
    logger.info('Attachment text extracted', {
      attachmentId: attachment.id,
      length: extraction.text.length,
      extractor: extraction.metadata.extractor,
      ocrUsed: extraction.metadata.ocrUsed,
    });
  };
}
