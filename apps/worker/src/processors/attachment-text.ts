import {
  mergePdfMetadata,
  type PdfDocumentInfoReader,
  type PdfTextExtractor,
} from '@exocortex/ai';
import { type PdfMetadata, type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
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
  /**
   * Reads the PDF's own metadata dictionary locally, before any engine runs.
   *
   * Separate from the chain on purpose. It produces no text, so it must not
   * make an unconfigured deployment look configured; and it must not depend on
   * which engine wins, because only one of the two engines ever reported the
   * dictionary, which used to make the free local engine the expensive choice.
   */
  documentInfo: PdfDocumentInfoReader;
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

    // Read from the file itself, so it is known whatever the engines do -- and
    // known even when all of them fail.
    const localInfo = await dependencies.documentInfo.read({
      data,
      correlationId: payload.correlationId,
    });

    // Each engine gets the whole document. A null `text` means "this engine
    // found nothing", which is a routine outcome for a scan hitting a text-only
    // engine, so the next one in the chain is tried before giving up. A thrown
    // error still bubbles: an unreachable Docling container must be retried,
    // not silently downgraded to a worse result.
    //
    // Metadata is collected from every attempt, not only the winning one, and
    // joined with the locally read dictionary. The three sources see different
    // things -- the file carries the title and the dates, Docling reports the
    // layout and whether OCR ran -- so an attempt that produced no text can
    // still be the only source of part of the answer.
    let text: string | null = null;
    let winner: PdfMetadata | null = null;
    const attempted: (PdfMetadata | null)[] = [];
    let firstError: unknown = null;

    for (const candidate of extractors) {
      let result;
      try {
        result = await candidate.extract({
          data,
          filename: attachment.filename,
          correlationId: payload.correlationId,
        });
      } catch (error) {
        // A broken engine must not take the chain down with it: a hosted call
        // that times out on a long document is exactly when the local one
        // should get its turn. The error is kept so that a run in which every
        // engine failed still ends as a retry rather than as "no text layer".
        firstError ??= error;
        logger.warn('PDF extraction engine failed, trying the next one', {
          attachmentId: attachment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (result.text !== null) {
        text = result.text;
        winner = result.metadata;
        break;
      }
      attempted.push(result.metadata);
    }

    // Every engine threw: nothing was learned, so this is a transient problem
    // and BullMQ should try again rather than the attachment being written off.
    if (text === null && firstError !== null) throw firstError;

    if (text === null) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          textStatus: 'FAILED',
          textExtractionError: 'No extractable text layer',
          // Even a total failure knows the page count and the title: they come
          // from the file, not from an engine.
          textMetadata: toJsonColumn(mergeAttempts(null, [localInfo, ...attempted])),
        },
      });
      logger.info('PDF has no extractable text layer', {
        attachmentId: attachment.id,
        enginesTried: extractors.length,
      });
      return;
    }

    const metadata = mergeAttempts(winner, [localInfo, ...attempted]);
    await prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        textStatus: 'READY',
        extractedText: text.slice(0, MAX_EXTRACTED_TEXT_CHARS),
        textExtractedAt: new Date(),
        textExtractionError: null,
        textMetadata: toJsonColumn(metadata),
      },
    });
    logger.info('Attachment text extracted', {
      attachmentId: attachment.id,
      length: text.length,
      extractor: metadata?.extractor,
      ocrUsed: metadata?.ocrUsed,
      pageCount: metadata?.pageCount,
    });
  };
}

/**
 * Prisma needs a sentinel rather than `null` for a Json column. `DbNull` is the
 * one that writes SQL NULL, i.e. "nothing was reported", as opposed to
 * `JsonNull`, which would store the JSON value `null`.
 */
function toJsonColumn(
  metadata: PdfMetadata | null,
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return metadata === null ? Prisma.DbNull : (metadata as unknown as Prisma.InputJsonObject);
}

/** First non-null attempt wins; the rest fill its gaps. */
function mergeAttempts(
  winner: PdfMetadata | null,
  attempted: readonly (PdfMetadata | null)[],
): PdfMetadata | null {
  if (winner !== null) return mergePdfMetadata(winner, attempted);
  const [first, ...rest] = attempted.filter((entry): entry is PdfMetadata => entry !== null);
  return first === undefined ? null : mergePdfMetadata(first, rest);
}
