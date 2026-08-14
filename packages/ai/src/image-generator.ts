import { deflateSync } from 'node:zlib';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/**
 * Turning a prompt into an image.
 *
 * Deliberately outside `AiProvider`, for the same reason `VisionPreprocessor`
 * is (ADR-012): the general chat path stays provider-neutral and text-only, and
 * a capability only one provider and one model can serve does not belong in the
 * interface every provider has to implement. Callers ask
 * `createImageGenerator` for one and treat `null` as "image generation is not
 * configured" — never as an error.
 */

export interface GenerateImageInput {
  /** What to draw, in the user's own words. Passed through, never rewritten. */
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  correlationId: string;
}

export interface GeneratedImage {
  data: Buffer;
  /** Always an `image/…` type; the caller re-checks the magic bytes anyway. */
  mimeType: string;
  /** Model that produced it, for logs and audit metadata. */
  model: string;
}

export interface ImageGenerator {
  readonly model: string;
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}

/** Longest prompt an image model is asked to read. */
export const MAX_IMAGE_PROMPT_CHARS = 1_000;

/**
 * Framing added around the user's prompt.
 *
 * A page cover is a wide banner behind a title, so the useful default is an
 * atmospheric image with no text and nothing important near the edges. The
 * user's own words come first and are never contradicted.
 */
const COVER_STYLE_HINT =
  'Wide banner image for the top of a document page, 16:5 aspect ratio. ' +
  'Atmospheric and uncluttered, with no text, no letters and no watermarks, ' +
  'and nothing important near the edges: a page title is drawn over it.';

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

export interface OpenRouterImageGeneratorOptions {
  apiKey: string;
  baseUrl: string;
  /** Image-capable model, e.g. `google/gemini-2.5-flash-image`. */
  model: string;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
  logger: Logger;
}

/** `data:image/png;base64,…` → bytes, or null when the shape is not that. */
function decodeDataUri(url: string): { data: Buffer; mimeType: string } | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
  if (match === null) return null;
  const [, mimeType, base64] = match;
  if (mimeType === undefined || base64 === undefined) return null;
  return { data: Buffer.from(base64, 'base64'), mimeType: mimeType.toLowerCase() };
}

/**
 * OpenRouter's image output: an ordinary chat completion asked for the `image`
 * modality, which answers with the picture inline as a data URI.
 */
export class OpenRouterImageGenerator implements ImageGenerator {
  public readonly model: string;

  private readonly options: OpenRouterImageGeneratorOptions;

  constructor(options: OpenRouterImageGeneratorOptions) {
    this.options = options;
    this.model = options.model;
  }

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
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
          modalities: ['image', 'text'],
          messages: [
            {
              role: 'user',
              content: `${input.prompt.slice(0, MAX_IMAGE_PROMPT_CHARS)}\n\n${COVER_STYLE_HINT}`,
            },
          ],
        }),
        signal,
      });

      if (!response.ok) {
        const detail = await response.text();
        this.options.logger.error('Image generation request failed', undefined, {
          status: response.status,
          model: this.options.model,
          correlationId: input.correlationId,
        });
        throw new AiProviderError(
          'ai_image_unavailable',
          `Image model responded with ${response.status}: ${detail.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[];
      };
      const url = payload.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (url === undefined) {
        throw new AiProviderError(
          'ai_image_empty',
          'The image model answered without an image. It may not support image output.',
        );
      }

      const decoded = decodeDataUri(url);
      if (decoded === null) {
        throw new AiProviderError(
          'ai_image_empty',
          'The image model returned something that was not an inline image',
        );
      }

      return { data: decoded.data, mimeType: decoded.mimeType, model: this.options.model };
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real, valid PNG of one solid colour. Small enough to build in memory. */
export function createSolidPng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter type "none"
    for (let x = 0; x < width; x += 1) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = rgb[0];
      raw[pixel + 1] = rgb[1];
      raw[pixel + 2] = rgb[2];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // 10..12 stay 0: deflate, adaptive filtering, no interlacing.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Offline stand-in, matching `MockAiProvider`: it makes no network call and
 * costs nothing, so a deployment without an API key can still be developed and
 * tested against. The colour is derived from the prompt, so the same prompt
 * always yields the same picture and a test can assert on it.
 */
export class MockImageGenerator implements ImageGenerator {
  public readonly model = 'mock-image';

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    let hash = 0;
    for (const character of input.prompt) {
      hash = (hash * 31 + character.codePointAt(0)!) % 0xffffff;
    }
    const rgb: [number, number, number] = [
      64 + ((hash >> 16) & 0x7f),
      64 + ((hash >> 8) & 0x7f),
      64 + (hash & 0x7f),
    ];
    return {
      data: createSolidPng(256, 80, rgb),
      mimeType: 'image/png',
      model: this.model,
    };
  }
}
