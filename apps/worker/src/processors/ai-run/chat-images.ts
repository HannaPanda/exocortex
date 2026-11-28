import { type AiImageInput, type AiPromptMessage } from '@exocortex/ai';
import {
  ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE,
  ATTACHMENT_IMAGE_MAX_BYTES,
} from '@exocortex/contracts';
import { type ObjectStorage, renderImageForAgent } from '@exocortex/storage';

/**
 * Pictures from the chat as pixels, for a model that sees images (issue #223,
 * ADR-097).
 *
 * A picture is read from storage when a run builds its prompt, scaled like the
 * image an agent reads (ADR-088), and kept for the rest of that run only: a
 * compaction that rebuilds the transcript does not read it twice, and nothing
 * of it is ever written into a stored message.
 */

/**
 * A message of the run's prompt. `withoutImages` is set on the note in front
 * of a user message whose pictures go as pixels: it is the same note with the
 * pictures' descriptions, for a turn that has to go without them.
 */
export type RunPromptMessage = AiPromptMessage & { withoutImages?: string };

interface PictureRow {
  id: string;
  storageKey: string;
  mimeType: string;
  createdAt: Date;
}

export class ChatImagePixels {
  private readonly cache = new Map<string, AiImageInput | null>();

  constructor(
    private readonly options: {
      storage: ObjectStorage;
      /** The newest pictures that go as pixels; older ones are read as descriptions. */
      maxImages: number;
      logger: { info: (message: string, context?: Record<string, unknown>) => void };
    },
  ) {}

  /**
   * The newest pictures among these rows, up to the limit, as images by
   * attachment id. A picture that cannot be read or scaled is logged and left
   * out, so it falls back to its description.
   */
  async load(rows: readonly PictureRow[]): Promise<Map<string, AiImageInput>> {
    const newest = [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, Math.max(this.options.maxImages, 0));
    return this.readAll(newest);
  }

  /**
   * The first `limit` of these rows in the order given, as images by
   * attachment id: the open page's pictures, which go in page order rather
   * than by age (issue #207). Read through the same cache, so a compaction
   * that rebuilds the prompt reads none of them twice.
   */
  async loadInOrder(
    rows: readonly PictureRow[],
    limit: number,
  ): Promise<Map<string, AiImageInput>> {
    return this.readAll(rows.slice(0, Math.max(limit, 0)));
  }

  private async readAll(rows: readonly PictureRow[]): Promise<Map<string, AiImageInput>> {
    const images = new Map<string, AiImageInput>();
    for (const row of rows) {
      const image = await this.read(row);
      if (image !== null) images.set(row.id, image);
    }
    return images;
  }

  private async read(row: PictureRow): Promise<AiImageInput | null> {
    const cached = this.cache.get(row.id);
    if (cached !== undefined) return cached;
    let image: AiImageInput | null = null;
    try {
      const stream = await this.options.storage.getObject({ key: row.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const rendered = await renderImageForAgent(Buffer.concat(chunks), row.mimeType, {
        maxEdge: ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE,
        maxBytes: ATTACHMENT_IMAGE_MAX_BYTES,
      });
      image = { mimeType: rendered.mimeType, data: rendered.body.toString('base64') };
    } catch (error) {
      this.options.logger.info('A chat picture goes as its description instead of pixels', {
        attachmentId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    this.cache.set(row.id, image);
    return image;
  }
}

/** How many pictures this prompt sends as pixels. */
export function imageInputCount(messages: readonly RunPromptMessage[]): number {
  return messages.reduce((total, message) => total + (message.images?.length ?? 0), 0);
}

/**
 * The same prompt without pixels (ADR-097): every picture is read as its
 * description, the way a model that cannot see gets it. For a turn the
 * provider refused because of its pictures.
 */
export function withoutImages(messages: readonly RunPromptMessage[]): RunPromptMessage[] {
  return messages.map((message) => {
    const { images, withoutImages: described, ...rest } = message;
    if (described !== undefined) return { ...rest, content: described };
    if (images !== undefined) return rest;
    return message;
  });
}

/**
 * The pixel reader for a run, or null when its pictures are read as
 * descriptions: the switch is off, the model does not see images, or the run
 * has no conversation to carry pictures (ADR-097).
 */
export function chatImagePixelsFor(input: {
  sendImagesToModel: boolean;
  supportsVision: boolean;
  conversationId: string | null;
  storage: ObjectStorage;
  maxImages: number;
  logger: { info: (message: string, context?: Record<string, unknown>) => void };
}): ChatImagePixels | null {
  if (!input.sendImagesToModel || !input.supportsVision || input.conversationId === null) {
    return null;
  }
  return new ChatImagePixels({
    storage: input.storage,
    maxImages: input.maxImages,
    logger: input.logger,
  });
}

/** Request errors a picture can cause: malformed, no such route, too large, unsupported, unprocessable. */
const IMAGE_REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 415, 422]);

/**
 * The prompt to ask a refused turn again with, or null when the refusal is
 * not one pictures can explain (ADR-097).
 *
 * A model marked as seeing images can still have a provider behind it that
 * takes no image input, and the endpoint snapshot does not say which one
 * does. A request error before any answer, while the prompt carries pixels,
 * is answered by sending the same prompt with the pictures' descriptions,
 * the way a model that cannot see reads them. A refused key or an outage is
 * not about pictures, and stays the failure it is. The result carries no
 * pixels, so a second refusal is never asked about again.
 */
export function describedAfterImageRefusal(
  turn: { text: string; failure: { status?: number } | null },
  messages: readonly RunPromptMessage[],
  context: {
    run: { id: string; model: string };
    logger: { warn: (message: string, context?: Record<string, unknown>) => void };
  },
): RunPromptMessage[] | null {
  const status = turn.failure?.status;
  if (status === undefined || !IMAGE_REFUSAL_STATUSES.has(status)) return null;
  const images = imageInputCount(messages);
  if (turn.text.length > 0 || images === 0) return null;
  context.logger.warn('The provider refused a turn with pictures; asking with descriptions', {
    runId: context.run.id,
    model: context.run.model,
    status,
    images,
  });
  return withoutImages(messages);
}
