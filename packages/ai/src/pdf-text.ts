import { type PdfMetadata } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

export { type PdfMetadata };

export interface PdfExtraction {
  /**
   * Null when this engine found no usable text. For the OpenRouter engine that
   * includes every scan, which is why the caller tries the next engine in the
   * chain before giving up.
   */
  text: string | null;
  /**
   * What this engine could tell about the document, independently of whether
   * it produced text. A scan has no readable text for the OpenRouter engine but
   * still carries a metadata dictionary that Docling cannot see, so the caller
   * merges metadata across every engine it tried.
   */
  metadata: PdfMetadata | null;
}

export interface PdfTextExtractor {
  /** Extracts the text of a PDF. Never rejects for "found nothing"; see `text`. */
  extract(input: {
    data: Uint8Array;
    filename: string;
    correlationId: string;
    timeoutMs?: number;
  }): Promise<PdfExtraction>;
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
 * PDF date strings, e.g. `D:20260806090613Z` or `D:20260426115610-00'00'`
 * (PDF 32000-1, 7.9.4). Everything after the year is optional in the spec, so
 * the missing parts default the way the spec says they do.
 */
const PDF_DATE =
  /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?)?/;

function parsePdfDate(value: string): string | null {
  const match = PDF_DATE.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, zulu, sign, offsetHours, offsetMinutes] = match;

  // No zone marker means local time to an unknown reader, so it is read as UTC
  // rather than as the server's accidental timezone.
  const zone =
    zulu !== undefined || sign === undefined
      ? 'Z'
      : `${sign}${offsetHours ?? '00'}:${offsetMinutes ?? '00'}`;
  const iso =
    `${year}-${month ?? '01'}-${day ?? '01'}` +
    `T${hour ?? '00'}:${minute ?? '00'}:${second ?? '00'}${zone}`;

  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Reads the `- Key=Value` lines of the plugin's metadata block.
 *
 * These are the PDF's own metadata dictionary entries, which is the one thing
 * this engine reports that Docling does not, so they are worth keeping even
 * when the page text turns out to be empty and another engine wins.
 */
function parsePdfTextMetadata(metadataBlock: string, pageText: string): Omit<PdfMetadata, 'extractor'> {
  const fields = new Map<string, string>();
  for (const line of metadataBlock.split('\n')) {
    const match = /^-\s*([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const value = (match[2] ?? '').trim();
    if (value.length > 0) fields.set(match[1] ?? '', value);
  }

  const date = (key: string): string | null => {
    const raw = fields.get(key);
    return raw === undefined ? null : parsePdfDate(raw);
  };

  // The plugin emits one `### Page n` heading per page even for empty pages,
  // which makes counting them a reliable page count.
  const pageCount = (pageText.match(/^### Page \d+$/gm) ?? []).length;

  return {
    title: fields.get('Title') ?? null,
    author: fields.get('Author') ?? null,
    creator: fields.get('Creator') ?? null,
    producer: fields.get('Producer') ?? null,
    createdAt: date('CreationDate'),
    modifiedAt: date('ModDate'),
    pageCount: pageCount === 0 ? null : pageCount,
    tableCount: null,
    pictureCount: null,
    confidence: null,
    ocrUsed: false,
  };
}

/** Every reportable field unset; spread over an `extractor` to build a metadata object. */
export const EMPTY_METADATA: Omit<PdfMetadata, 'extractor'> = {
  title: null,
  author: null,
  creator: null,
  producer: null,
  createdAt: null,
  modifiedAt: null,
  pageCount: null,
  tableCount: null,
  pictureCount: null,
  confidence: null,
  ocrUsed: null,
};

/**
 * Merges what several engines reported into one record.
 *
 * The engine whose text was kept wins every field it can answer; the engines
 * tried before it fill the gaps. That is what turns "OpenRouter saw the title
 * and the dates, Docling saw the pages and ran OCR" into a single answer.
 */
export function mergePdfMetadata(
  winner: PdfMetadata,
  earlier: readonly (PdfMetadata | null)[],
): PdfMetadata {
  const merged: PdfMetadata = { ...winner };
  for (const candidate of earlier) {
    if (candidate === null) continue;
    for (const key of Object.keys(EMPTY_METADATA) as (keyof Omit<PdfMetadata, 'extractor'>)[]) {
      if (merged[key] === null) {
        // Index-signature-free assignment: each key's type is identical on both
        // sides, but TypeScript cannot prove that through a union of keys.
        Object.assign(merged, { [key]: candidate[key] });
      }
    }
  }
  return merged;
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
    async extract(input): Promise<PdfExtraction> {
      const controller = new AbortController();
      // 60 s was too tight: a 33-page document aborted on all five BullMQ
      // attempts, and because an abort throws, the OCR engine behind this one
      // never got a turn either.
      const timeoutMs = input.timeoutMs ?? 240_000;
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
        if (text.trim().length === 0) return { text: null, metadata: null };

        // An unrecognised shape is passed through untouched; only the known
        // skeleton is judged on its page text and mined for metadata.
        const split = splitPdfTextOutput(text);
        if (split === null) {
          return { text, metadata: { extractor: 'openrouter', ...EMPTY_METADATA, ocrUsed: false } };
        }

        const metadata: PdfMetadata = {
          extractor: 'openrouter',
          ...parsePdfTextMetadata(split.metadataBlock, text),
        };

        if (split.pageText.trim().length < MIN_CONTENT_CHARS) {
          options.logger.info('PDF text plugin returned no page content', {
            correlationId: input.correlationId,
          });
          // The metadata dictionary survives even though the text did not, so
          // the OCR engine behind this one does not have to rediscover it.
          return { text: null, metadata };
        }

        return { text, metadata };
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
