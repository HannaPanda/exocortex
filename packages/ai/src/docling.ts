import { z } from 'zod';

import { type Logger } from '@exocortex/logger';

import { EMPTY_METADATA, type PdfExtraction, type PdfTextExtractor } from './pdf-text';
import { AiProviderError } from './provider';

/**
 * Fixed conversion options.
 *
 * docling-serve caches one pipeline per distinct option set, and building a
 * pipeline costs ~18 s. Varying these per request would pay that cost again for
 * every variant, so the option set is deliberately a constant rather than
 * something the settings table can tune.
 *
 * `do_ocr: true` with `force_ocr: false` is the hybrid mode: an existing text
 * layer is used as-is and only bitmap regions go through OCR. Forcing OCR was
 * measured to be strictly worse on a text-layer PDF (7 549 vs 9 278 characters
 * on the same three pages), so there is no reason to expose it.
 */
const CONVERSION_OPTIONS = {
  // Markdown keeps tables and headings intact, which matters more for the
  // reading AI than raw text does. This is an interchange format for a derived
  // cache, not collaborative state (ADR-007).
  to_formats: ['md', 'json'],
  do_ocr: true,
  force_ocr: false,
  table_mode: 'accurate',
  // Images become a placeholder rather than an inline base64 blob; the vision
  // preprocessor is the path for describing pictures.
  image_export_mode: 'placeholder',
  do_table_structure: true,
  abort_on_error: false,
} as const;

/**
 * The subset of docling-serve's `ConvertDocumentResponse` this extractor reads.
 *
 * Verified against docling-serve 1.29.0 (`GET /openapi.json`) and against real
 * conversions on 2026-08-06. Unknown keys are dropped by zod, so a newer server
 * adding fields cannot break the parse; `json_content` is matched loosely for
 * the same reason, since a `DoclingDocument` is large and its shape is owned by
 * the docling schema (1.10.0 at the time of writing), not by us.
 */
const doclingResponseSchema = z.object({
  status: z.enum(['pending', 'started', 'failure', 'success', 'partial_success', 'skipped']),
  document: z.object({
    md_content: z.string().nullable().default(null),
    json_content: z
      .object({
        pages: z.record(z.string(), z.unknown()).nullable().default(null),
        tables: z.array(z.unknown()).nullable().default(null),
        pictures: z.array(z.unknown()).nullable().default(null),
      })
      .nullable()
      .default(null),
  }),
  errors: z
    .array(z.object({ error_message: z.string().default(''), category: z.string().default('') }))
    .default([]),
  confidence: z
    .object({
      mean_score: z.number().nullable().default(null),
      ocr_score: z.number().nullable().default(null),
    })
    .nullable()
    .default(null),
});

export interface DoclingPdfExtractorOptions {
  /** Base URL of docling-serve, e.g. `http://127.0.0.1:5010`. No trailing slash. */
  baseUrl: string;
  logger: Logger;
}

/**
 * PDF text extraction through a local docling-serve instance.
 *
 * The reason this exists next to `createOpenRouterPdfExtractor` is OCR: the
 * OpenRouter `pdf-text` engine returns an empty document for a scan, which the
 * attachment-text processor can only record as a failure. Docling reads the
 * same scan (measured: 0 characters without OCR, 8 378 characters with it).
 *
 * Conversion is CPU-bound and slow: roughly 1.5 s per page plus a one-off
 * pipeline warm-up, so a 33-page document took 50 s on eight cores. The
 * `attachment-text` queue runs with concurrency 1, so a long conversion delays
 * only other PDF extractions.
 */
export function createDoclingPdfExtractor(options: DoclingPdfExtractorOptions): PdfTextExtractor {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async extract(input): Promise<PdfExtraction> {
      const controller = new AbortController();
      // Generous by default because the work is per-page, not per-request.
      const timeoutMs = input.timeoutMs ?? 900_000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/v1/convert/source`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            options: {
              ...CONVERSION_OPTIONS,
              // Let the server give up before the client does, so a runaway
              // document is reported as a failure instead of an aborted socket.
              document_timeout: Math.floor((timeoutMs / 1_000) * 0.9),
            },
            sources: [
              {
                kind: 'file',
                filename: input.filename,
                base64_string: Buffer.from(input.data).toString('base64'),
              },
            ],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text();
          options.logger.error('Docling conversion request failed', undefined, {
            status: response.status,
            correlationId: input.correlationId,
          });
          throw new AiProviderError(
            'ai_provider_unavailable',
            `Docling responded with ${response.status}: ${detail.slice(0, 200)}`,
          );
        }

        const parsed = doclingResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          throw new AiProviderError(
            'ai_provider_unavailable',
            `Docling returned an unexpected response shape: ${parsed.error.message.slice(0, 200)}`,
          );
        }
        const payload = parsed.data;

        // A malformed or unreadable file comes back as HTTP 200 with
        // `status: 'failure'` and a populated `errors` array (verified with a
        // non-PDF payload). That will not change on retry, so it is reported as
        // "no extractable content" rather than raised as a provider error.
        if (payload.status === 'failure' || payload.status === 'skipped') {
          options.logger.info('Docling could not convert the document', {
            correlationId: input.correlationId,
            status: payload.status,
            reason: payload.errors[0]?.error_message ?? 'unknown',
          });
          return { text: null, metadata: null };
        }

        const document = payload.document.json_content;
        const metadata = {
          ...EMPTY_METADATA,
          extractor: 'docling',
          pageCount: document?.pages === null ? null : Object.keys(document?.pages ?? {}).length,
          tableCount: document?.tables?.length ?? null,
          pictureCount: document?.pictures?.length ?? null,
          confidence: payload.confidence?.mean_score ?? null,
          // `ocr_score` stays null when the pipeline never ran OCR, which is
          // exactly the signal for "this document had a usable text layer".
          ocrUsed: payload.confidence === null ? null : payload.confidence.ocr_score !== null,
        };

        const text = payload.document.md_content ?? '';
        // Layout facts are worth keeping even for a document that yielded no
        // text: "three pages, no content" is a real answer.
        return { text: text.trim().length === 0 ? null : text, metadata };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** Null when no docling-serve URL is configured (same seam as createPdfTextExtractor). */
export function createOptionalDoclingPdfExtractor(options: {
  baseUrl: string | undefined;
  logger: Logger;
}): PdfTextExtractor | null {
  if (options.baseUrl === undefined || options.baseUrl.length === 0) return null;
  return createDoclingPdfExtractor({ baseUrl: options.baseUrl, logger: options.logger });
}
