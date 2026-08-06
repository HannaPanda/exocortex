import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

export interface PdfTextExtractor {
  /**
   * Extracts the text layer of a PDF.
   *
   * Returns null when the document has no extractable text (a pure scan). The
   * caller records that as FAILED with a clear reason rather than retrying.
   */
  extract(input: {
    data: Uint8Array;
    filename: string;
    correlationId: string;
    timeoutMs?: number;
  }): Promise<string | null>;
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
 */
export function createOpenRouterPdfExtractor(
  options: OpenRouterPdfExtractorOptions,
): PdfTextExtractor {
  return {
    async extract(input): Promise<string | null> {
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
        return text.trim().length === 0 ? null : text;
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
