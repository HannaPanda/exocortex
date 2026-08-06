import { PDFDocument } from 'pdf-lib';

import { type PdfMetadata } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { EMPTY_METADATA } from './pdf-text';

/**
 * The PDF's own metadata dictionary, read locally.
 *
 * Every PDF carries an `/Info` dictionary in its trailer: title, author, the
 * producing software, and the creation and modification dates. It sits in the
 * file, so reading it is a local, free, millisecond operation -- and it must
 * never be the reason a document is sent to a paid API.
 *
 * That used to be exactly the situation. The hosted `pdf-text` plugin reported
 * the dictionary as a side effect of transcribing the text, and Docling reports
 * none of it (verified on 2026-08-06 against the live container with a PDF
 * carrying all five fields: not one of them appears anywhere in the response,
 * whose `origin` is limited to `{mimetype, binary_hash, filename}`). So making
 * the free local engine the default silently cost the title, the author and the
 * dates. Reading the dictionary here decouples the two: whichever engine
 * produces the text, the dictionary is already known.
 *
 * This is not a text extractor and deliberately does not implement
 * `PdfTextExtractor`. It never produces text, so it must not count towards the
 * "is any engine configured" question the processor asks of its chain.
 */
export interface PdfDocumentInfoReader {
  /** Never rejects: an unreadable file yields null, it does not fail the job. */
  read(input: { data: Uint8Array; correlationId: string }): Promise<PdfMetadata | null>;
}

/**
 * `pdf-lib` rewrites the Producer and the modification date of every document
 * it loads unless this is off. The flag is named for `save()`, but the
 * `PDFDocument` constructor applies it on load, so leaving it at its default
 * would mean reading back pdf-lib's own name instead of the document's.
 */
const LOAD_OPTIONS = {
  updateMetadata: false,
  // An encrypted document should yield what it can (the page count) rather
  // than throwing; its strings are handled below.
  ignoreEncryption: true,
  // Malformed indirect objects are common in real-world PDFs and are not a
  // reason to abandon the dictionary.
  throwOnInvalidObject: false,
} as const;

/**
 * Reads one dictionary entry defensively.
 *
 * Each pdf-lib getter throws rather than returning undefined when the entry has
 * an unexpected type, and a malformed `/CreationDate` throws while being parsed.
 * Real-world PDFs contain both. One bad entry must not cost the other five.
 */
function entry<T>(read: () => T | undefined): T | null {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

/** Trims and maps blank to null, so "unset" and "empty string" read the same. */
function text(read: () => string | undefined): string | null {
  const value = entry(read)?.trim() ?? '';
  return value.length === 0 ? null : value;
}

function isoDate(read: () => Date | undefined): string | null {
  const value = entry(read);
  if (value === null || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

export function createPdfDocumentInfoReader(options: { logger: Logger }): PdfDocumentInfoReader {
  return {
    async read(input): Promise<PdfMetadata | null> {
      let document: PDFDocument;
      try {
        document = await PDFDocument.load(input.data, LOAD_OPTIONS);
      } catch (error) {
        // A file the parser cannot open is still a file an OCR engine may well
        // read, so this is logged and shrugged off rather than thrown.
        options.logger.info('PDF metadata dictionary unreadable', {
          correlationId: input.correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }

      // With `ignoreEncryption` the document loads, but its strings are still
      // ciphertext -- pdf-lib does not decrypt. Reporting them would mean
      // storing garbage as the title, so only the structure is trusted.
      const readable = !document.isEncrypted;

      const pageCount = entry(() => document.getPageCount()) ?? 0;
      return {
        ...EMPTY_METADATA,
        extractor: 'pdf-info',
        title: readable ? text(() => document.getTitle()) : null,
        author: readable ? text(() => document.getAuthor()) : null,
        creator: readable ? text(() => document.getCreator()) : null,
        producer: readable ? text(() => document.getProducer()) : null,
        createdAt: readable ? isoDate(() => document.getCreationDate()) : null,
        modifiedAt: readable ? isoDate(() => document.getModificationDate()) : null,
        pageCount: pageCount === 0 ? null : pageCount,
      };
    },
  };
}
