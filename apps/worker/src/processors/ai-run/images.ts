import { type VisionPreprocessor } from '@exocortex/ai';
import { type AiMessage, fenceUntrustedContent } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ProseMirrorNode } from '@exocortex/editor';
import { type ObjectStorage } from '@exocortex/storage';

/** No page needs more than this many images described for one answer (default; overridden by `ai.visionMaxImagesPerRun`). */
export const MAX_IMAGES_PER_RUN = 4;

const ATTACHMENT_DOWNLOAD_PATH = /^\/api\/attachments\/([^/]+)\/download$/;

/** Depth-first collection of every `image` node's `src` attribute. */
function collectImageSources(node: ProseMirrorNode | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  const sources: string[] = [];
  if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.length > 0) {
    sources.push(node.attrs.src);
  }
  for (const child of node.content ?? []) sources.push(...collectImageSources(child));
  return sources;
}

/**
 * Describes the images in a document through the vision preprocessor, so a
 * text-only main driver can use them as context.
 *
 * Best-effort throughout: a document that fails to load, an attachment that
 * cannot be resolved or a single failed description never fails the run --
 * they are logged and skipped, and the text answer proceeds either with
 * fewer images described or with none (docs/adr/ADR-012-vision-preprocessing.md).
 */
export async function describeDocumentImages(input: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  visionPreprocessor: VisionPreprocessor;
  workspaceId: string;
  documentId: string;
  correlationId: string;
  logger: { info: (message: string, context?: Record<string, unknown>) => void };
  maxImages: number;
}): Promise<AiMessage | null> {
  const { prisma, storage, workspaceId, documentId, logger } = input;

  const content = await prisma.documentContent.findUnique({
    where: { documentId },
    select: { proseMirrorJson: true },
  });
  const sources = collectImageSources(content?.proseMirrorJson as ProseMirrorNode | null);
  if (sources.length === 0) return null;

  const truncated = sources.slice(0, input.maxImages);
  if (sources.length > truncated.length) {
    logger.info('Describing only the first images on the page', {
      documentId,
      total: sources.length,
      described: truncated.length,
    });
  }

  const descriptions: string[] = [];
  for (const src of truncated) {
    const attachmentId = ATTACHMENT_DOWNLOAD_PATH.exec(src)?.[1];
    if (attachmentId === undefined) continue;

    // Scoped to the run's own workspace and document: a src attribute is part
    // of stored document JSON, not user input, but this keeps a stale or
    // forged reference from reaching another workspace's attachment.
    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, workspaceId, documentId, deletedAt: null },
    });
    if (attachment === null || !attachment.mimeType.startsWith('image/')) continue;

    try {
      const stream = await storage.getObject({ key: attachment.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const description = await input.visionPreprocessor.describeImage({
        data: Buffer.concat(chunks),
        mimeType: attachment.mimeType,
        label: attachment.filename,
        correlationId: input.correlationId,
        timeoutMs: 20_000,
      });
      if (description.length > 0) {
        descriptions.push(`${attachment.filename}: ${description}`);
      }
    } catch (error) {
      logger.info('Skipping an image that could not be described', {
        documentId,
        attachmentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (descriptions.length === 0) return null;
  // Fenced like any other foreign text (issue #56): an image is a file
  // somebody uploaded, and a screenshot of a paragraph addressed to the model
  // reaches the prompt exactly as a paragraph would. The description is a
  // vision model's reading of it, which changes nothing about who wrote it.
  return {
    role: 'system',
    content: fenceUntrustedContent({
      origin: 'attachment',
      label: 'Bilder der geöffneten Seite',
      text:
        'Image context from the current page, described by a separate vision model -- ' +
        'you cannot see these images directly, only this description:\n\n' +
        descriptions.map((description, index) => `${index + 1}. ${description}`).join('\n'),
    }),
  };
}
