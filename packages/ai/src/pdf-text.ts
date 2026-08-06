import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/**
 * Structural facts an extractor can report about a converted PDF.
 *
 * Every field except `extractor` is nullable because the two implementations
 * see very different amounts of the document: the OpenRouter `file-parser`
 * plugin returns text and nothing else, while Docling returns a full layout
 * model. A null therefore means "this engine cannot tell", never "zero".
 */
export interface PdfMetadata {
  /** Engine that produced the text, e.g. `openrouter` or `docling`. */
  extractor: string;
  pageCount: number | null;
  tableCount: number | null;
  pictureCount: number | null;
  /** The engine's own confidence in the conversion, 0 to 1. */
  confidence: number | null;
  /** Whether OCR contributed text, i.e. the document had bitmap content. */
  ocrUsed: boolean | null;
}

export interface PdfExtraction {
  text: string;
  metadata: PdfMetadata;
}

export interface PdfTextExtractor {
  /**
   * Extracts the text of a PDF.
   *
   * Returns null when the document has no extractable content. For the
   * OpenRouter engine that includes every scan, which is precisely why the
   * caller tries the next extractor in the chain before giving up.
   */
  extract(input: {
    data: Uint8Array;
    filename: string;
    correlationId: string;
    timeoutMs?: number;
  }): Promise<PdfExtraction | null>;
}

export interface OpenRouterPdfExtractorOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  appUrl: string;
  logger: Logger;
}

const EXTRACTION_PROMPT =
  'Gib den vollständigen Text dieses Dokuments unverändert zurück. Keine Zusammenfassung, keine Kommentare.';

/**
 * The `pdf-text` plugin always answers with the same skeleton, verified live on
 * 2026-08-06 against both a text-layer PDF and a scan:
 *
 * ```
 * # document.pdf
 * ## Metadata
 * - Title=…
 * - CreationDate=…
 *
 * ## Contents
 * ### Page 1
 * …page text…
 * ```
 *
 * A scan yields that skeleton with every page empty: roughly 300 characters of
 * PDF header fields and not one word of the document. That is a non-empty
 * string, so a plain length check accepts it and caches the header as if it
 * were the content -- and the OCR-capable engine behind it never gets a turn.
 * Emptiness therefore has to be decided on the page text, not on the response.
 *
 * The model sometimes wraps the whole skeleton in a `<file name="…">` element
 * and sometimes does not (both observed against the same document), so markup
 * is stripped before the page text is judged. Otherwise a lone `</file>` counts
 * as content and the scan is accepted again.
 */
const CONTENTS_MARKER = '\n## Contents\n';
const PAGE_HEADING = /^### Page \d+$/gm;
const MARKUP_TAG = /<\/?[a-z][^>]*>/gi;
/** Below this, a document carries nothing worth caching or handing to a model. */
const MIN_CONTENT_CHARS = 16;

/** Null when the response does not follow the skeleton above. */
function splitPdfTextOutput(raw: string): { metadataBlock: string; pageText: string } | null {
  const index = raw.indexOf(CONTENTS_MARKER);
  if (index === -1) return null;
  return {
    metadataBlock: raw.slice(0, index),
    pageText: raw
      .slice(index + CONTENTS_MARKER.length)
      .replace(PAGE_HEADING, '')
      .replace(MARKUP_TAG, ''),
  };
}

/**
 * PDF text extraction through OpenRouter's `file-parser` plugin.
 *
 * The `pdf-text` engine is free and runs on OpenRouter's side, which keeps this
 * repository free of a PDF parsing dependency and of any native build step. The
 * PDF is sent as a base64 `file` content part; the model is asked only to return
 * the text verbatim, so the plugin does the work and the model does almost none.
 *
 * Verified against the live API on 2026-08-06 (a 148 KB real-world PDF): the
 * plugin returns the document's text through the ordinary chat-completions
 * response shape, so no fallback (`unpdf`) is needed.
 *
 * The engine has no OCR: a scanned PDF comes back empty. `createDoclingPdfExtractor`
 * is the answer to that, chained behind this one.
 */
export function createOpenRouterPdfExtractor(
  options: OpenRouterPdfExtractorOptions,
): PdfTextExtractor {
  return {
    async extract(input): Promise<PdfExtraction | null> {
      const controller = new AbortController();
      const timeoutMs = input.timeoutMs ?? 60_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const dataUri = `data:application/pdf;base64,${Buffer.from(input.data).toString('base64')}`;
        const response = await fetch(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': options.appUrl,
            'X-Title': 'Exocortex',
          },
          body: JSON.stringify({
            model: options.model,
            plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: EXTRACTION_PROMPT },
                  {
                    type: 'file',
                    file: { filename: input.filename, file_data: dataUri },
                  },
                ],
              },
            ],
            max_tokens: 32_000,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          options.logger.error('PDF text extraction request failed', undefined, {
            status: response.status,
            correlationId: input.correlationId,
          });
          throw new AiProviderError(
            'ai_provider_unavailable',
            `PDF text extraction responded with ${response.status}: ${detail.slice(0, 200)}`,
          );
        }

        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = payload.choices?.[0]?.message?.content ?? '';
        if (text.trim().length === 0) return null;

        // An unrecognised shape is passed through untouched; only the known
        // skeleton is judged on its page text.
        const split = splitPdfTextOutput(text);
        if (split !== null && split.pageText.trim().length < MIN_CONTENT_CHARS) {
          options.logger.info('PDF text plugin returned no page content', {
            correlationId: input.correlationId,
          });
          return null;
        }

        return {
          text,
          // The plugin reports nothing beyond the text itself.
          metadata: {
            extractor: 'openrouter',
            pageCount: null,
            tableCount: null,
            pictureCount: null,
            confidence: null,
            ocrUsed: false,
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Null when the API key or the model is unconfigured (same seam as createVisionPreprocessor). */
export function createPdfTextExtractor(options: {
  apiKey: string;
  baseUrl: string;
  model: string | undefined;
  appUrl: string;
  logger: Logger;
}): PdfTextExtractor | null {
  if (options.apiKey.length === 0 || options.model === undefined || options.model.length === 0) {
    return null;
  }
  return createOpenRouterPdfExtractor({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    appUrl: options.appUrl,
    logger: options.logger,
  });
}
