import { type AiChatAttachment, screeningFromColumn } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

/**
 * Files on chat messages (issue #223): how a row is read and how it becomes
 * a contract, shared by the services that answer with messages.
 */

export const CHAT_ATTACHMENT_SELECT = {
  id: true,
  filename: true,
  mimeType: true,
  byteSize: true,
  imageDescription: true,
  screening: true,
  createdAt: true,
  conversationMessageId: true,
} as const;

export interface ChatAttachmentRow {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  imageDescription: string | null;
  screening: 'CLEAN' | 'FLAGGED' | 'FAILED' | null;
  createdAt: Date;
  conversationMessageId: string | null;
}

export function chatAttachmentToContract(row: ChatAttachmentRow): AiChatAttachment {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    description: row.imageDescription,
    screening: screeningFromColumn(row.screening),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The files each of these messages carried, in the order they were added.
 *
 * A file somebody removed after sending is left out rather than shown as
 * broken: its row is marked deleted and its bytes are gone.
 */
export async function loadMessageAttachments(
  prisma: PrismaClient,
  messageIds: readonly string[],
): Promise<Map<string, AiChatAttachment[]>> {
  const byMessage = new Map<string, AiChatAttachment[]>();
  if (messageIds.length === 0) return byMessage;
  const rows = await prisma.attachment.findMany({
    where: { conversationMessageId: { in: [...messageIds] }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: CHAT_ATTACHMENT_SELECT,
  });
  for (const row of rows) {
    if (row.conversationMessageId === null) continue;
    const list = byMessage.get(row.conversationMessageId) ?? [];
    list.push(chatAttachmentToContract(row));
    byMessage.set(row.conversationMessageId, list);
  }
  return byMessage;
}
