import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

export interface VisionPreprocessorOptions {
  apiKey: string;
  baseUrl: string;
  /** Vision-capable model. Never the main driver model (see registry.ts). */
  model: string;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
  logger: Logger;
}

export interface DescribeImageInput {
  data: Uint8Array | Buffer;
  mimeType: string;
  /** Filename or similar, folded into the prompt as a hint only. */
  label?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  correlationId: string;
}

const DESCRIBE_PROMPT =
  'Describe this image factually and in detail: visible text (verbatim where legible), ' +
  'objects, layout, charts or diagrams, and anything else relevant to understanding why ' +
  'it might be in a document. Plain prose, no preamble.';

/**
 * Turns a single image into a text description using a cheap vision-capable
 * model, so a text-only main driver (e.g. GLM, see registry.ts) can reason
 * about it.
 *
 * Deliberately outside the `AiProvider` contract: the general chat path stays
 * provider-neutral and text-only (ADR-009); this is a narrow, explicit
 * escape hatch used only for document-image preprocessing
 * (docs/adr/ADR-012-vision-preprocessing.md). It talks to OpenRouter's
 * multimodal `image_url` content shape directly rather than going through
 * `AiMessage`, whose `content` is a plain string by design.
 */
export class VisionPreprocessor {
  private readonly options: VisionPreprocessorOptions;

  constructor(options: VisionPreprocessorOptions) {
    this.options = options;
  }

  async describeImage(input: DescribeImageInput): Promise<string> {
    const dataUri = `data:${input.mimeType};base64,${Buffer.from(input.data).toString('base64')}`;
    const prompt =
      input.label === undefined || input.label.length === 0
        ? DESCRIBE_PROMPT
        : `${DESCRIBE_PROMPT}\n\nFilename: ${input.label}`;

    const controller = input.timeoutMs === undefined ? null : new AbortController();
    const timeout =
      controller === null ? null : setTimeout(() => controller.abort(), input.timeoutMs);
    const signal = controller?.signal ?? input.signal ?? null;

    try {
      const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.options.appUrl,
          'X-Title': 'eXocortex',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUri } },
              ],
            },
          ],
          max_tokens: 512,
          temperature: 0.2,
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        this.options.logger.error('Vision preprocessing request failed', undefined, {
          status: response.status,
          correlationId: input.correlationId,
        });
        throw new AiProviderError(
          'ai_vision_unavailable',
          `Vision model responded with ${response.status}: ${detail.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return payload.choices?.[0]?.message?.content ?? '';
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}
