import {
  type AiChatAttachmentTextState,
  type AttachmentTrust,
  attachmentTrustNote,
  fenceUntrustedContent,
  isAttachmentImageSource,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { type RunPromptMessage } from './chat-images';

/**
 * Documents on a chat message, and the files of messages a compaction took in
 * (issue #223).
 *
 * A document is read through the text its extraction left on the row
 * (ADR-050), or, for a text, Markdown or JSON file, the text it arrived as.
 * Where it reaches a prompt it is fenced as attachment content, cut to a
 * budget per message; the rest is read with `exo_attachment_read_text`, which
 * answers the same text to the same person. Pure text builders apart from the
 * wait, so the wording is tested as text.
 */

/** Characters of document text one message carries into every turn, shared by its files. */
export const CHAT_DOCUMENT_PROMPT_CHARS = 24_000;

/** How long a run waits for a document's text that is still being read. */
export const CHAT_DOCUMENT_WAIT_MS = 45_000;

/** A document as the prompt builder needs it. */
export interface ChatDocumentForPrompt {
  id: string;
  filename: string;
  state: AiChatAttachmentTextState;
  text: string | null;
  /** The extraction itself was cut before it was stored. */
  truncated: boolean;
  trust?: AttachmentTrust;
}

function readLater(id: string): string {
  return `mit exo_attachment_read_text und der Kennung ${id}`;
}

/**
 * The part of the note in front of a user message that is about its
 * documents, or null when it has none.
 */
export function chatDocumentContext(documents: readonly ChatDocumentForPrompt[]): string | null {
  if (documents.length === 0) return null;
  const ready = documents.filter((file) => file.state === 'ready' && file.text !== null);
  const share = Math.floor(CHAT_DOCUMENT_PROMPT_CHARS / Math.max(ready.length, 1));

  const parts = [
    documents.length === 1
      ? 'Die Nutzerin hat der folgenden Nachricht eine Datei angehängt.'
      : `Die Nutzerin hat der folgenden Nachricht ${String(documents.length)} Dateien angehängt.`,
  ];
  if (ready.length > 0) {
    parts.push(
      fenceUntrustedContent({
        origin: 'attachment',
        label: 'Dateien zur Nachricht',
        text: ready
          .map((file) => `### ${file.filename}\n\n${(file.text ?? '').slice(0, share)}`)
          .join('\n\n'),
      }),
    );
  }
  // Outside the fence: this deployment's sentences about the files.
  for (const file of ready) {
    const length = file.text?.length ?? 0;
    if (length > share || file.truncated) {
      parts.push(
        `${file.filename}: oben stehen die ersten ${String(Math.min(share, length))} Zeichen; ` +
          `den Rest liest du ${readLater(file.id)}.`,
      );
    }
    const note = file.trust === undefined ? null : attachmentTrustNote(file.trust);
    if (note !== null) parts.push(`${file.filename}: ${note}`);
  }
  for (const file of documents) {
    if (file.state === 'pending') {
      parts.push(
        `${file.filename}: Der Text wird noch gelesen. Sag das, statt den Inhalt zu erraten; ` +
          `später liest du ihn ${readLater(file.id)}.`,
      );
    } else if (file.state !== 'ready' || file.text === null) {
      parts.push(
        `${file.filename}: Der Text dieser Datei ließ sich nicht lesen. Sag das, statt den ` +
          'Inhalt zu erraten.',
      );
    }
  }
  return parts.join('\n\n');
}

/** A file on a message a compaction took in, as the note after the summary needs it. */
export interface CarriedFile {
  id: string;
  filename: string;
  picture: boolean;
  description: string | null;
  trust?: AttachmentTrust;
}

/**
 * The note after a compaction summary naming the files of the messages it
 * took in (issue #223): a picture by its description, fenced, a document by
 * its name and how to read it. A summary is written from message text and
 * knows nothing of either. Null when there are none.
 */
export function carriedFilesContext(files: readonly CarriedFile[]): RunPromptMessage | null {
  if (files.length === 0) return null;
  const described = files.filter((file) => file.picture && file.description !== null);
  const parts = ['Zu den zusammengefassten Nachrichten gehörten diese Dateien der Nutzerin.'];
  if (described.length > 0) {
    parts.push(
      fenceUntrustedContent({
        origin: 'attachment',
        label: 'Bilder aus zusammengefassten Nachrichten',
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
  for (const file of files) {
    if (!file.picture) parts.push(`${file.filename}: Dokument, lesbar ${readLater(file.id)}.`);
    else if (file.description === null) parts.push(`${file.filename}: Bild, nicht beschrieben.`);
  }
  for (const file of described) {
    const note = file.trust === undefined ? null : attachmentTrustNote(file.trust);
    if (note !== null) parts.push(`${file.filename}: ${note}`);
  }
  return { role: 'system', content: parts.join('\n\n') };
}

/**
 * The ids of retired messages whose files still belong in the context: the
 * ones an active compaction summary took in, and, through a summary that was
 * itself summarised, the ones before. A message `/clear` retired has no
 * summary, so it is not among them.
 */
export async function summarizedMessageIds(
  prisma: PrismaClient,
  conversationId: string,
): Promise<string[]> {
  const summaries = await prisma.aiConversationMessage.findMany({
    where: { conversationId, supersededAt: null, isSummary: true },
    select: { id: true },
  });
  const found: string[] = [];
  let frontier = summaries.map((summary) => summary.id);
  // Bounded: one step per compaction the conversation went through.
  for (let depth = 0; frontier.length > 0 && depth < 32; depth += 1) {
    const rows = await prisma.aiConversationMessage.findMany({
      where: { conversationId, summarizedIntoId: { in: frontier } },
      select: { id: true, isSummary: true },
    });
    found.push(...rows.map((row) => row.id));
    frontier = rows.filter((row) => row.isSummary).map((row) => row.id);
  }
  return found;
}

/**
 * Waits, bounded, until every document on the active transcript has its text
 * and its screening (ADR-096), so the run that answers the message reads the
 * file rather than a sentence saying it is still being read. A document still
 * pending after the wait goes in with that sentence.
 */
export async function awaitChatDocumentTexts(input: {
  prisma: PrismaClient;
  conversationId: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (input.timeoutMs ?? CHAT_DOCUMENT_WAIT_MS);
  while (true) {
    const rows = await input.prisma.attachment.findMany({
      where: {
        conversationId: input.conversationId,
        deletedAt: null,
        conversationMessage: { is: { supersededAt: null } },
        OR: [{ textStatus: 'PENDING' }, { textStatus: 'READY', screening: null }],
      },
      select: { mimeType: true },
    });
    const waiting = rows.some((row) => !isAttachmentImageSource(row.mimeType));
    if (!waiting) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 1_000));
  }
}
