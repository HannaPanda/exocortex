import {
  type DocumentTextExtractor,
  mergeDocumentTextMetadata,
  OfficeExtractionRefused,
  type PdfDocumentInfoReader,
} from '@exocortex/ai';
import {
  ATTACHMENT_TEXT_MAX_CHARS,
  attachmentTextEngine,
  type AttachmentTextErrorCode,
  type DocumentTextMetadata,
  isAttachmentTextErrorCode,
  QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

export interface AttachmentTextDependencies {
  prisma: PrismaClient;
  storage: ObjectStorage;
  queues: QueueRegistry;
  /**
   * Engines to try in order, derived from the current settings. Empty when
   * nothing is configured (D6's "unconfigured" seam).
   *
   * The order is what turns a scanned PDF from a dead end into a result: the
   * OpenRouter engine returns nothing for a scan, and Docling behind it reads
   * the same file through OCR.
   */
  extractors: (settings: Settings) => readonly DocumentTextExtractor[];
  /**
   * The local converter for the office formats (issue #38).
   *
   * Not part of the chain above and not a chain of its own: there is exactly
   * one engine that reads a docx here, so a document it refuses is a settled
   * answer rather than a reason to try something else.
   */
  officeExtractor: DocumentTextExtractor;
  /**
   * Reads the PDF's own metadata dictionary locally, before any engine runs.
   *
   * Separate from the chain on purpose. It produces no text, so it must not
   * make an unconfigured deployment look configured; and it must not depend on
   * which engine wins, because only one of the two engines ever reported the
   * dictionary, which used to make the free local engine the expensive choice.
   */
  documentInfo: PdfDocumentInfoReader;
  settings: (workspaceId?: string) => Promise<Settings>;
}

/**
 * Extracts and caches the text of an attachment (D6, issue #38).
 *
 * Two engines behind one job, chosen by MIME type: a PDF goes through the
 * chain of PDF engines, and the office formats go to the local converter. The
 * split is `attachmentTextEngine` in the contracts, so the worker and the four
 * places in the API that ask "can this file have text at all" cannot drift.
 *
 * Idempotent, following `materialize-document.ts`: a `READY` attachment is
 * never re-extracted, even by a retried job -- with one deliberate exception.
 * `reason: 'forced'` is the explicit "no, really, again" from
 * `AttachmentsService.forceReextract` (issue #2): a successful extraction can
 * still be a *wrong* one (OCR misreads, a table falls apart), and until now
 * the only way out was deleting the attachment and re-uploading it. Every
 * other reason leaves a `READY` attachment alone.
 *
 * A correction living in `correctedText` is never touched by this job, forced
 * or not: only a human write (`AttachmentsService.correctText`) may set or
 * clear it, so a re-extraction can refresh the machine result without ever
 * discarding what someone fixed by hand.
 *
 * `exo_attachment_read_text` (the MCP/AI-facing read path) never extracts on
 * its own -- it only reads this cache or reports `pending`, which is what
 * keeps that surface fast and Redis-free.
 */
export function createAttachmentTextProcessor(dependencies: AttachmentTextDependencies) {
  const { prisma } = dependencies;

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

    if (attachment.textStatus === 'READY' && payload.reason !== 'forced') {
      // Idempotency: a retried job must not re-extract, unless it was asked to.
      logger.info('Skipping attachment text extraction: already ready', {
        attachmentId: attachment.id,
      });
      return;
    }

    // Asked before anything about engines, which is the other way round from
    // how this used to run: a PNG on a deployment with no PDF engine was told
    // "PDF extraction is not configured" and left in FAILED, where the file
    // bar then offered a retry that could never do anything. What kind of file
    // this is does not depend on what is configured.
    const engine = attachmentTextEngine(attachment.mimeType);
    if (engine === null) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: { textStatus: 'NOT_APPLICABLE' },
      });
      return;
    }

    const settings = await dependencies.settings(payload.workspaceId);

    const outcome =
      engine === 'pdf'
        ? await extractFromPdf({ dependencies, attachment, settings, payload, logger })
        : await extractFromOffice({ dependencies, attachment, settings, payload, logger });

    if (outcome === 'unavailable') return;

    await prisma.attachment.update({ where: { id: attachment.id }, data: outcome });

    // What is findable about the page changed, although the page did not
    // (issue #101). Enqueued for a failure as well: the previous run may have
    // put text in the index that this one just invalidated.
    if (attachment.documentId !== null) {
      await dependencies.queues.enqueue(QUEUE_NAMES.searchIndexing, {
        correlationId: payload.correlationId,
        documentId: attachment.documentId,
        workspaceId: attachment.workspaceId,
        reason: 'attachment_text',
      });
    }
  };
}

/**
 * What an engine decided, in the shape the attachment row is written with.
 *
 * `unavailable` is the one outcome that writes nothing at all, because it was
 * already written: the engine reported a configuration problem and said so on
 * the row itself before returning.
 */
type ExtractionOutcome = Prisma.AttachmentUpdateInput | 'unavailable';

interface EngineContext {
  dependencies: AttachmentTextDependencies;
  attachment: {
    id: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    storageKey: string;
  };
  settings: Settings;
  payload: JobContext<typeof QUEUE_NAMES.attachmentText>['payload'];
  logger: JobContext<typeof QUEUE_NAMES.attachmentText>['logger'];
}

/** Reads the object once, whichever engine is about to be handed it. */
async function readAttachment(context: EngineContext): Promise<Buffer> {
  // Anything from here on (a network error, a storage read failure) is left to
  // bubble so BullMQ applies the configured retry policy -- FAILED is reserved
  // for outcomes that will not change on retry.
  const stream = await context.dependencies.storage.getObject({
    key: context.attachment.storageKey,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function extractFromPdf(context: EngineContext): Promise<ExtractionOutcome> {
  const { dependencies, attachment, settings, payload, logger } = context;
  const extractors = dependencies.extractors(settings);

  if (extractors.length === 0 || !settings['ai.pdfExtractionEnabled']) {
    await dependencies.prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        textStatus: 'FAILED',
        textExtractionError: 'PDF extraction is not configured',
        textErrorCode: 'pdfDisabled' satisfies AttachmentTextErrorCode,
        textTruncated: false,
      },
    });
    logger.info('Attachment text extraction unavailable', { attachmentId: attachment.id });
    return 'unavailable';
  }

  if (attachment.byteSize > settings['ai.pdfMaxBytes']) {
    logger.info('Skipping attachment text extraction: PDF too large', {
      attachmentId: attachment.id,
      byteSize: attachment.byteSize,
    });
    return {
      textStatus: 'FAILED',
      textExtractionError: `PDF exceeds the configured size limit (${attachment.byteSize} > ${settings['ai.pdfMaxBytes']} bytes)`,
      textErrorCode: 'tooLarge' satisfies AttachmentTextErrorCode,
      textTruncated: false,
    };
  }

  const data = await readAttachment(context);

  // Read from the file itself, so it is known whatever the engines do -- and
  // known even when all of them fail.
  const localInfo = await dependencies.documentInfo.read({
    data,
    correlationId: payload.correlationId,
  });

  // Each engine gets the whole document, and every attempt's metadata is
  // joined with the locally read dictionary below: the three sources see
  // different things (the file carries the title and the dates, Docling
  // reports the layout and whether OCR ran).
  const { text, winner, attempted, firstError } = await runExtractorChain(
    extractors,
    { data, filename: attachment.filename, correlationId: payload.correlationId },
    logger,
    attachment.id,
  );

  // Every engine threw: nothing was learned, so this is a transient problem
  // and BullMQ should try again rather than the attachment being written off.
  if (text === null && firstError !== null) throw firstError;

  if (text === null) {
    logger.info('PDF has no extractable text layer', {
      attachmentId: attachment.id,
      enginesTried: extractors.length,
    });
    return {
      textStatus: 'FAILED',
      textExtractionError: 'No extractable text layer',
      textErrorCode: 'noTextLayer' satisfies AttachmentTextErrorCode,
      // Even a total failure knows the page count and the title: they come
      // from the file, not from an engine.
      textMetadata: toJsonColumn(mergeAttempts(null, [localInfo, ...attempted])),
      textTruncated: false,
    };
  }

  return readyUpdate(text, mergeAttempts(winner, [localInfo, ...attempted]), attachment.id, logger);
}

/**
 * The office formats, through the one local converter (issue #38).
 *
 * No chain and no metadata reader beside it: the converter is the only engine
 * that reads these formats, and what it can say about the document it says in
 * the conversion. A document it refuses is refused for a reason that names the
 * document, so that answer is written to the row rather than retried.
 */
async function extractFromOffice(context: EngineContext): Promise<ExtractionOutcome> {
  const { dependencies, attachment, settings, payload, logger } = context;

  if (!settings['ai.officeExtractionEnabled']) {
    await dependencies.prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        textStatus: 'FAILED',
        textExtractionError: 'Office text extraction is switched off',
        textErrorCode: 'officeDisabled' satisfies AttachmentTextErrorCode,
        textTruncated: false,
      },
    });
    logger.info('Attachment text extraction unavailable', { attachmentId: attachment.id });
    return 'unavailable';
  }

  if (attachment.byteSize > settings['ai.officeMaxBytes']) {
    logger.info('Skipping attachment text extraction: document too large', {
      attachmentId: attachment.id,
      byteSize: attachment.byteSize,
    });
    return {
      textStatus: 'FAILED',
      textExtractionError: `Document exceeds the configured size limit (${attachment.byteSize} > ${settings['ai.officeMaxBytes']} bytes)`,
      textErrorCode: 'tooLarge' satisfies AttachmentTextErrorCode,
      textTruncated: false,
    };
  }

  const data = await readAttachment(context);

  let result;
  try {
    result = await dependencies.officeExtractor.extract({
      data,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      correlationId: payload.correlationId,
    });
  } catch (error) {
    // Only a refusal about this document is settled. A broken binding or an
    // out-of-memory is not, and rethrowing it is what makes BullMQ retry.
    if (!(error instanceof OfficeExtractionRefused)) throw error;
    return {
      textStatus: 'FAILED',
      textExtractionError: error.message,
      // The converter's own code, when it is one a reader has words for.
      textErrorCode: isAttachmentTextErrorCode(error.code) ? error.code : null,
      textTruncated: false,
    };
  }

  if (result.text === null) {
    logger.info('Document converted to no text at all', { attachmentId: attachment.id });
    return {
      textStatus: 'FAILED',
      textExtractionError: 'The document converted to no text',
      textErrorCode: 'empty' satisfies AttachmentTextErrorCode,
      textMetadata: toJsonColumn(result.metadata),
      textTruncated: false,
    };
  }

  return readyUpdate(result.text, result.metadata, attachment.id, logger);
}

/** The one successful write, shared so the cap and the log cannot diverge. */
function readyUpdate(
  text: string,
  metadata: DocumentTextMetadata | null,
  attachmentId: string,
  logger: JobContext<typeof QUEUE_NAMES.attachmentText>['logger'],
): Prisma.AttachmentUpdateInput {
  // Cut silently until now (issue #2): `textTruncated` is what lets the UI
  // say so instead of a long scan looking like a complete result.
  const truncated = text.length > ATTACHMENT_TEXT_MAX_CHARS;
  logger.info('Attachment text extracted', {
    attachmentId,
    length: text.length,
    truncated,
    extractor: metadata?.extractor,
    ocrUsed: metadata?.ocrUsed,
    pageCount: metadata?.pageCount,
  });
  return {
    textStatus: 'READY',
    extractedText: text.slice(0, ATTACHMENT_TEXT_MAX_CHARS),
    textExtractedAt: new Date(),
    textExtractionError: null,
    textErrorCode: null,
    textMetadata: toJsonColumn(metadata),
    textTruncated: truncated,
  };
}

/** What the chain of engines learned, whether or not any of them produced text. */
interface ExtractorChainResult {
  text: string | null;
  /** Metadata of the engine that produced the text, `null` when none did. */
  winner: DocumentTextMetadata | null;
  /** Metadata of the engines that ran but found nothing. */
  attempted: (DocumentTextMetadata | null)[];
  /** The first thrown error, kept so an all-failed run ends as a retry. */
  firstError: unknown;
}

/**
 * Runs the engines in order and stops at the first one that produces text.
 *
 * A null `text` means "this engine found nothing", which is a routine outcome
 * for a scan hitting a text-only engine, so the next one in the chain is tried
 * before giving up. Metadata is collected from every attempt, not only the
 * winning one: the sources see different things, so an attempt that produced no
 * text can still be the only source of part of the answer.
 */
async function runExtractorChain(
  extractors: readonly DocumentTextExtractor[],
  input: { data: Buffer; filename: string; correlationId: string },
  logger: JobContext<typeof QUEUE_NAMES.attachmentText>['logger'],
  attachmentId: string,
): Promise<ExtractorChainResult> {
  const attempted: (DocumentTextMetadata | null)[] = [];
  let firstError: unknown = null;

  for (const candidate of extractors) {
    let result;
    try {
      result = await candidate.extract(input);
    } catch (error) {
      // A broken engine must not take the chain down with it: a hosted call
      // that times out on a long document is exactly when the local one
      // should get its turn. The error is kept so that a run in which every
      // engine failed still ends as a retry rather than as "no text layer".
      firstError ??= error;
      logger.warn('PDF extraction engine failed, trying the next one', {
        attachmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (result.text !== null) {
      return { text: result.text, winner: result.metadata, attempted, firstError };
    }
    attempted.push(result.metadata);
  }

  return { text: null, winner: null, attempted, firstError };
}

/**
 * Prisma needs a sentinel rather than `null` for a Json column. `DbNull` is the
 * one that writes SQL NULL, i.e. "nothing was reported", as opposed to
 * `JsonNull`, which would store the JSON value `null`.
 */
function toJsonColumn(
  metadata: DocumentTextMetadata | null,
): Prisma.InputJsonObject | typeof Prisma.DbNull {
  return metadata === null ? Prisma.DbNull : (metadata as unknown as Prisma.InputJsonObject);
}

/** First non-null attempt wins; the rest fill its gaps. */
function mergeAttempts(
  winner: DocumentTextMetadata | null,
  attempted: readonly (DocumentTextMetadata | null)[],
): DocumentTextMetadata | null {
  if (winner !== null) return mergeDocumentTextMetadata(winner, attempted);
  const [first, ...rest] = attempted.filter(
    (entry): entry is DocumentTextMetadata => entry !== null,
  );
  return first === undefined ? null : mergeDocumentTextMetadata(first, rest);
}
