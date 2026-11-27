import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiChatAttachment,
  ATTACHMENT_TEXT_MAX_CHARS,
  chatAttachmentDeclaredType,
  chatAttachmentTextStateOf,
  isChatAttachmentMimeType,
  isChatPlainTextMimeType,
  QUEUE_NAMES,
  type UploadChatAttachmentResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { CHAT_ATTACHMENT_SELECT, chatAttachmentToContract } from './chat-attachments';
import { loadOwnedConversation } from './conversation-mapping';

/**
 * Files on chat messages (issue #223).
 *
 * A picture is uploaded the moment it is pasted, dropped or chosen, so the chip
 * above the composer can show it, and is bound to the message that carries it
 * when that message is sent. Until then it belongs to the conversation and to
 * nothing else: removing the chip deletes it, a day without a send lets the
 * nightly sweep take it, and deleting the conversation takes everything.
 *
 * Every limit is one the deployment already has: the upload's size and the
 * magic-byte check are `AttachmentsService.upload`, a document's extraction is
 * the one every upload gets (ADR-050), and how many files one message may
 * carry is `ai.visionMaxImagesPerRun`, because no run describes more pictures
 * than that.
 */
@Injectable()
export class ChatAttachmentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly attachments: AttachmentsService,
    private readonly settings: SettingsService,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
  ) {}

  async upload(input: {
    conversationId: string;
    userId: string;
    filename: string;
    declaredMimeType: string | undefined;
    body: Buffer;
    correlationId: string;
  }): Promise<UploadChatAttachmentResponse> {
    const conversation = await loadOwnedConversation(
      this.prisma,
      this.access,
      input.conversationId,
      input.userId,
    );

    const limit = await this.limitFor(conversation.workspaceId);
    const waiting = await this.prisma.attachment.count({
      where: {
        conversationId: conversation.id,
        createdById: input.userId,
        conversationMessageId: null,
        deletedAt: null,
      },
    });
    if (waiting >= limit) throw limitError(limit);

    const uploaded = await this.attachments.upload({
      workspaceId: conversation.workspaceId,
      userId: input.userId,
      documentId: null,
      conversationId: conversation.id,
      filename: input.filename,
      declaredMimeType: chatAttachmentDeclaredType(input.filename, input.declaredMimeType),
      body: input.body,
      correlationId: input.correlationId,
      accept: isChatAttachmentMimeType,
    });

    const textStatus = isChatPlainTextMimeType(uploaded.attachment.mimeType)
      ? await this.storePlainText({
          attachmentId: uploaded.attachment.id,
          workspaceId: conversation.workspaceId,
          body: input.body,
          correlationId: input.correlationId,
        })
      : (
          await this.prisma.attachment.findUniqueOrThrow({
            where: { id: uploaded.attachment.id },
            select: { textStatus: true },
          })
        ).textStatus;

    return {
      attachment: {
        id: uploaded.attachment.id,
        filename: uploaded.attachment.filename,
        mimeType: uploaded.attachment.mimeType,
        byteSize: uploaded.attachment.byteSize,
        description: null,
        textState: chatAttachmentTextStateOf(textStatus),
        screening: null,
        createdAt: uploaded.attachment.createdAt,
      },
    };
  }

  /**
   * A text, Markdown or JSON file is its own text: it is stored as the
   * extracted text right away, so the assistant, `exo_attachment_read_text`
   * and the screening (ADR-096) read it like any extraction, and the
   * screening is queued like the one after an extraction. Cut at the same
   * length an extraction is.
   */
  private async storePlainText(input: {
    attachmentId: string;
    workspaceId: string;
    body: Buffer;
    correlationId: string;
  }): Promise<'READY'> {
    const text = new TextDecoder('utf-8').decode(input.body);
    await this.prisma.attachment.update({
      where: { id: input.attachmentId },
      data: {
        extractedText: text.slice(0, ATTACHMENT_TEXT_MAX_CHARS),
        textTruncated: text.length > ATTACHMENT_TEXT_MAX_CHARS,
        textStatus: 'READY',
        textExtractedAt: new Date(),
      },
    });
    await this.queues.enqueue(QUEUE_NAMES.attachmentText, {
      correlationId: input.correlationId,
      attachmentId: input.attachmentId,
      workspaceId: input.workspaceId,
      reason: 'screen',
    });
    return 'READY';
  }

  /**
   * Proves that every id names an unsent file of this conversation, uploaded
   * by its owner, and that there are not more than a run describes. Called
   * before the message is written, so a refused send leaves nothing behind.
   */
  async assertSendable(input: {
    conversationId: string;
    workspaceId: string;
    userId: string;
    attachmentIds: readonly string[];
  }): Promise<void> {
    const ids = [...new Set(input.attachmentIds)];
    if (ids.length === 0) return;
    const limit = await this.limitFor(input.workspaceId);
    if (ids.length > limit) throw limitError(limit);
    const found = await this.prisma.attachment.count({
      where: {
        id: { in: ids },
        conversationId: input.conversationId,
        createdById: input.userId,
        conversationMessageId: null,
        deletedAt: null,
      },
    });
    if (found !== ids.length) {
      throw new AppError(
        'ai_chat_attachment_invalid',
        'An attachment is not an unsent file of this conversation',
        { attachmentIds: ids },
      );
    }
  }

  /** Binds the files to the message that carried them and answers them in order. */
  async bind(input: {
    conversationId: string;
    messageId: string;
    attachmentIds: readonly string[];
  }): Promise<AiChatAttachment[]> {
    const ids = [...new Set(input.attachmentIds)];
    if (ids.length === 0) return [];
    const bound = await this.prisma.attachment.updateMany({
      where: {
        id: { in: ids },
        conversationId: input.conversationId,
        conversationMessageId: null,
        deletedAt: null,
      },
      data: { conversationMessageId: input.messageId },
    });
    if (bound.count !== ids.length) {
      // Two sends of the same files at once, the only way past
      // `assertSendable`; the files went with whichever message came first.
      this.logger.warn('Some chat attachments were bound by another message', {
        conversationId: input.conversationId,
        messageId: input.messageId,
        requested: ids.length,
        bound: bound.count,
      });
    }
    const rows = await this.prisma.attachment.findMany({
      where: { conversationMessageId: input.messageId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: CHAT_ATTACHMENT_SELECT,
    });
    return rows.map(chatAttachmentToContract);
  }

  /**
   * Removes the bytes of every file a conversation held, after its rows went
   * with it (the foreign key cascades). Read before the delete, removed after:
   * a failed object delete then leaves an object without a row, which is
   * logged, rather than a row pointing at nothing.
   */
  async storageKeysOf(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { conversationId },
      select: { storageKey: true, previewKey: true },
    });
    return rows.flatMap((row) =>
      [row.storageKey, row.previewKey].filter((key): key is string => key !== null),
    );
  }

  async deleteObjects(input: {
    conversationId: string;
    keys: readonly string[];
  }): Promise<{ removed: number; failed: number }> {
    let removed = 0;
    let failed = 0;
    for (const key of input.keys) {
      try {
        await this.storage.deleteObject({ key });
        removed += 1;
      } catch (error) {
        failed += 1;
        this.logger.error('Failed to delete a chat attachment object', error, {
          conversationId: input.conversationId,
          storageKey: key,
        });
      }
    }
    return { removed, failed };
  }

  private async limitFor(workspaceId: string): Promise<number> {
    const { settings } = await this.settings.forWorkspace(workspaceId);
    return settings['ai.visionMaxImagesPerRun'];
  }
}

function limitError(limit: number): AppError {
  return new AppError(
    'ai_chat_attachments_limit',
    `A message may carry at most ${String(limit)} pictures (ai.visionMaxImagesPerRun)`,
    { limit },
  );
}
