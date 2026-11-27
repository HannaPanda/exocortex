import {
  type AiMessage,
  ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE,
  ATTACHMENT_IMAGE_MAX_BYTES,
  fenceUntrustedContent,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ObjectStorage, renderImageForAgent } from '@exocortex/storage';

import { type ToolImageDescriber } from '../../tool-images';

/**
 * Pictures somebody put on a chat message (issue #223).
 *
 * The built-in loop's messages stay text (ADR-009, ADR-088): a picture reaches
 * the model as a vision model's description of it, written once by the first
 * run that sees the message and kept on the attachment row, so the
 * conversation does not pay for the same picture on every turn. Where it
 * reaches a prompt it is fenced as attachment content and closes writing for
 * that run under its policy (ADR-030), exactly like the pictures of the open
 * page.
 */

/** What the transcript loader needs to know about one file on a message. */
export interface ChatAttachmentForPrompt {
  filename: string;
  description: string | null;
}

const UNSEEN =
  'nicht angesehen: kein Bildmodell verfügbar oder die Beschreibung ist fehlgeschlagen. ' +
  'Sag das, statt den Inhalt zu erraten.';

/**
 * The message that stands before a user message with pictures, or null for a
 * message without any. Pure, so the wording and the fence are tested as text.
 *
 * Only the descriptions are fenced: they are a vision model's reading of an
 * uploaded file. The note that a picture could not be seen is this
 * deployment's own sentence, and fencing it would mark a run as having read
 * foreign text it never received.
 */
export function chatAttachmentContext(
  attachments: readonly ChatAttachmentForPrompt[],
): AiMessage | null {
  if (attachments.length === 0) return null;
  const described = attachments.filter((file) => file.description !== null);
  const unseen = attachments.filter((file) => file.description === null);

  const parts = [
    attachments.length === 1
      ? 'Die Nutzerin hat der folgenden Nachricht ein Bild angehängt. Du siehst es nicht selbst.'
      : `Die Nutzerin hat der folgenden Nachricht ${String(attachments.length)} Bilder angehängt. ` +
        'Du siehst sie nicht selbst.',
  ];
  if (described.length > 0) {
    parts.push(
      fenceUntrustedContent({
        origin: 'attachment',
        label: 'Bilder zur Nachricht',
        text:
          'Beschreibung durch ein Bildmodell:\n\n' +
          described
            .map(
              (file, index) => `${String(index + 1)}. ${file.filename}: ${file.description ?? ''}`,
            )
            .join('\n'),
      }),
    );
  }
  for (const file of unseen) parts.push(`${file.filename}: ${UNSEEN}`);
  return { role: 'system', content: parts.join('\n\n') };
}

/**
 * The pictures on the active transcript's messages, per message id. Files
 * removed after sending are left out; the message stands on its own then.
 */
export async function loadChatAttachmentsForPrompt(
  prisma: PrismaClient,
  messageIds: readonly string[],
): Promise<Map<string, ChatAttachmentForPrompt[]>> {
  const byMessage = new Map<string, ChatAttachmentForPrompt[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await prisma.attachment.findMany({
    where: { conversationMessageId: { in: [...messageIds] }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { conversationMessageId: true, filename: true, imageDescription: true },
  });
  for (const row of rows) {
    if (row.conversationMessageId === null) continue;
    const list = byMessage.get(row.conversationMessageId) ?? [];
    list.push({ filename: row.filename, description: row.imageDescription });
    byMessage.set(row.conversationMessageId, list);
  }
  return byMessage;
}

/**
 * Whether the prompt this conversation sends carries a picture's description,
 * which is what makes the run one that has read foreign text (ADR-030).
 */
export async function transcriptCarriesChatImages(
  prisma: PrismaClient,
  conversationId: string,
): Promise<boolean> {
  const count = await prisma.attachment.count({
    where: {
      conversationId,
      deletedAt: null,
      imageDescription: { not: null },
      conversationMessage: { is: { supersededAt: null } },
    },
  });
  return count > 0;
}

/**
 * Describes the pictures on messages still in the context that nobody has
 * described yet, oldest first and at most `maxImages` of them, and stores
 * each description on its row.
 *
 * Best effort like the open page's pictures (ADR-012): a picture that cannot
 * be read or described is logged and left without a description, which the
 * prompt then says, and the next run tries again. A run never fails because
 * of a picture.
 */
export async function describeChatAttachments(input: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  describer: { describe: ToolImageDescriber; model: string | null } | null;
  conversationId: string;
  maxImages: number;
  logger: { info: (message: string, context?: Record<string, unknown>) => void };
}): Promise<number> {
  const { prisma, describer, logger } = input;
  if (describer === null || input.maxImages <= 0) return 0;

  const pending = await prisma.attachment.findMany({
    where: {
      conversationId: input.conversationId,
      deletedAt: null,
      imageDescription: null,
      conversationMessage: { is: { supersededAt: null } },
    },
    orderBy: { createdAt: 'asc' },
    take: input.maxImages,
    select: { id: true, storageKey: true, mimeType: true, filename: true },
  });

  let described = 0;
  for (const attachment of pending) {
    try {
      const stream = await input.storage.getObject({ key: attachment.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      // Scaled like the image read an agent gets (ADR-088): a twelve-megapixel
      // photo is bandwidth and tokens a vision model does not use.
      const image = await renderImageForAgent(Buffer.concat(chunks), attachment.mimeType, {
        maxEdge: ATTACHMENT_IMAGE_DEFAULT_MAX_EDGE,
        maxBytes: ATTACHMENT_IMAGE_MAX_BYTES,
      });
      const description = (
        await describer.describe(
          { data: image.body.toString('base64'), mimeType: image.mimeType },
          attachment.filename,
        )
      ).trim();
      if (description.length === 0) throw new Error('empty description');
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          imageDescription: description,
          imageDescribedAt: new Date(),
          imageDescriptionModel: describer.model,
        },
      });
      described += 1;
    } catch (error) {
      logger.info('Skipping a chat picture that could not be described', {
        conversationId: input.conversationId,
        attachmentId: attachment.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return described;
}
