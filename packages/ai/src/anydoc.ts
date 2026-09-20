import { OFFICE_ATTACHMENT_MIME_TYPES } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import {
  type DocumentTextExtraction,
  type DocumentTextExtractor,
  EMPTY_METADATA,
} from './pdf-text';

/**
 * Text extraction for Word, Excel, PowerPoint, OpenDocument, RTF, EPUB and CSV
 * attachments (issue #38), through the anydoc library.
 *
 * Unlike the two PDF engines this sits beside, it is neither a container nor a
 * hosted call: anydoc is a Rust library behind N-API bindings, so a conversion
 * is a function call on the libuv thread pool costing single-digit milliseconds
 * and no tokens. That is why it needs no chain, no fallback and no timeout --
 * there is nothing for it to fall back to, and nothing to wait on.
 *
 * PDF is deliberately not routed here although anydoc reads one. Measured on
 * 2026-09-20 against the PDFs this deployment actually holds, anydoc is 30 to
 * 100 times faster than Docling and loses word boundaries doing it: a
 * justified, hyphenated page came back with 689 line-break hyphens left in
 * place and twice as many run-together words, which is precisely the text the
 * search index and the embeddings are built from. The full measurement is in
 * `docs/ai-architecture.md`. Speed is not what a PDF's text is judged on here,
 * so `ai.pdfExtractor` keeps its two engines and this one stays out of them.
 *
 * The library is also never asked to do OCR. Its `hosted` mode would upload the
 * document to Firecrawl's API, and a local extractor that quietly ships a file
 * off the machine is not a local extractor; scans are Docling's job and Docling
 * runs in a container on this host.
 */

/**
 * The library's own format names, keyed by the MIME type this deployment
 * detected. The format is passed explicitly rather than letting anydoc sniff
 * the bytes again, so the upload allow list stays the single decision about
 * what this deployment accepts -- and so CSV, which carries no signature and
 * which anydoc would therefore refuse to identify, arrives named.
 */
const FORMAT_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'text/csv': 'csv',
};

/**
 * The library's typed surface, as this file uses it.
 *
 * Declared here rather than imported because the package is loaded lazily (see
 * `load` below), and an `import type` from a module that may be absent at
 * runtime is still a compile-time dependency on its types being resolvable.
 * The shape is copied from `@firecrawl/anydoc`'s `anydoc.d.ts` at 0.2.4, which
 * is the version the workspace pins.
 */
interface AnydocModule {
  toMarkdownBytes(bytes: Uint8Array, format?: string | null): Promise<string>;
}

/**
 * Error codes the library rejects with that describe the document rather than
 * the run, mapped to what a person reading the file's text bar should be told.
 *
 * Everything not named here -- a broken binding, an out-of-memory -- is left to
 * throw, so the job retries instead of the attachment being written off. The
 * split is the same one `attachment-text.ts` already makes for the PDF chain:
 * a `null` text is a settled "there is nothing to read", a throw is "ask again".
 */
const SETTLED_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unsupported: 'Dieses Dateiformat kann nicht gelesen werden',
  malformed: 'Die Datei ist beschädigt und enthält keinen lesbaren Text',
  encrypted: 'Die Datei ist passwortgeschützt',
  missingPart: 'Der Datei fehlt ein Teil, ohne den sie keinen Text ergibt',
  resourceLimit: 'Die Datei überschreitet eine Sicherheitsgrenze des Konverters',
  // Only reachable for a PDF, which never gets here -- named so a future
  // routing change fails loudly in review rather than silently at runtime.
  needsOcr: 'Die Datei besteht aus Bildern und bräuchte Texterkennung',
};

/** A settled refusal carries the sentence a reader sees instead of text. */
export class OfficeExtractionRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OfficeExtractionRefused';
  }
}

export interface AnydocExtractorOptions {
  logger: Logger;
  /**
   * Overridable for tests only: the real one imports the native package, which
   * a unit test must not need on the machine running it.
   */
  load?: () => Promise<AnydocModule>;
}

async function loadAnydoc(): Promise<AnydocModule> {
  // Imported by name at call time so that a platform without a prebuilt binary
  // fails one extraction rather than the worker's boot.
  const loaded: unknown = await import('@firecrawl/anydoc');
  const candidate = loaded as { toMarkdownBytes?: unknown };
  if (typeof candidate.toMarkdownBytes !== 'function') {
    throw new Error('The installed @firecrawl/anydoc does not expose toMarkdownBytes');
  }
  return loaded as AnydocModule;
}

/**
 * Whether this engine reads a file of this type at all.
 *
 * The same list the contract publishes, asked as a question, so the worker can
 * route without knowing anything about the library's format names.
 */
export function isOfficeMimeType(mimeType: string): boolean {
  return (OFFICE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function createAnydocExtractor(options: AnydocExtractorOptions): DocumentTextExtractor {
  const load = options.load ?? loadAnydoc;

  return {
    async extract(input): Promise<DocumentTextExtraction> {
      const format = FORMAT_BY_MIME_TYPE[input.mimeType ?? ''];
      if (format === undefined) {
        throw new OfficeExtractionRefused(
          'unsupported',
          SETTLED_ERROR_MESSAGES.unsupported ?? 'Unsupported format',
        );
      }

      const anydoc = await load();
      let markdown: string;
      try {
        markdown = await anydoc.toMarkdownBytes(input.data, format);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const settled = typeof code === 'string' ? SETTLED_ERROR_MESSAGES[code] : undefined;
        if (settled === undefined) throw error;
        options.logger.info('Office extraction refused the document', {
          correlationId: input.correlationId,
          code,
        });
        throw new OfficeExtractionRefused(code as string, settled);
      }

      // An empty conversion is a real answer for an empty spreadsheet, and it
      // is reported the same way the PDF engines report it.
      return {
        text: markdown.trim().length === 0 ? null : markdown,
        metadata: {
          extractor: 'anydoc',
          ...EMPTY_METADATA,
          // Nothing was rendered, so nothing was recognised from a bitmap.
          ocrUsed: false,
        },
      };
    },
  };
}
