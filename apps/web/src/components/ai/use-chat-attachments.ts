'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AiChatAttachment,
  CHAT_ATTACHMENT_MIME_TYPES,
  chatAttachmentDeclaredType,
  isAttachmentImageSource,
  isChatAttachmentMimeType,
  type UploadChatAttachmentResponse,
} from '@exocortex/contracts';

import { ApiError, apiRequest, uploadRequest } from '@/lib/api/client';

/** A picture or document waiting above the composer for the next message (issue #223). */
export interface PendingChatFile {
  /** Local, so a chip has a key before the upload has answered. */
  localId: string;
  name: string;
  /** A picture shows itself on its chip; a document shows an icon. */
  kind: 'picture' | 'document';
  /** An object URL of a picture: the chip shows it before the server has it. Empty for a document. */
  previewUrl: string;
  status: 'uploading' | 'ready';
  attachment: AiChatAttachment | null;
}

export interface ChatAttachments {
  files: readonly PendingChatFile[];
  /** Pasted, dropped or chosen files; anything the chat does not take is refused with a sentence. */
  add: (files: readonly File[]) => void;
  /** Takes a chip away and deletes its upload. */
  remove: (localId: string) => void;
  /** A file is still on its way: sending now would leave it behind. */
  uploading: boolean;
  /** The ids that go with the message being sent. */
  readyIds: string[];
  /**
   * The ids for a message into `conversationId`: none for a message that
   * starts a conversation of its own, since the pictures belong to the open one.
   */
  idsFor: (conversationId: string | null) => string[];
  /** After a send: the files went with the message and are no longer pending. */
  sent: () => void;
}

function markReady(
  files: readonly PendingChatFile[],
  localId: string,
  attachment: AiChatAttachment,
): PendingChatFile[] {
  return files.map((file) =>
    file.localId === localId ? { ...file, status: 'ready', attachment } : file,
  );
}

/**
 * What a file picker offers: the types, and the extensions of text a browser
 * often names with no type at all.
 */
export const CHAT_FILE_INPUT_ACCEPT = [
  ...CHAT_ATTACHMENT_MIME_TYPES,
  '.md',
  '.txt',
  '.json',
  '.csv',
].join(',');

/** Whether the chat takes this file, judged by its type or, for text, its name. */
export function isChatFile(file: File): boolean {
  return isChatAttachmentMimeType(chatAttachmentDeclaredType(file.name, file.type) ?? '');
}

/** A picture by its type; everything else the chat takes is a document. */
export function chatFileKind(file: File): 'picture' | 'document' {
  return isAttachmentImageSource(file.type) ? 'picture' : 'document';
}

/** Uploads one file into a conversation, for the composer and for a chat begun elsewhere. */
export async function uploadChatFile(
  conversationId: string,
  file: File,
): Promise<AiChatAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  const { attachment } = await uploadRequest<UploadChatAttachmentResponse>(
    `/api/ai/conversations/${conversationId}/attachments`,
    form,
  );
  return attachment;
}

type ContextTranslator = ReturnType<typeof useTranslations<'ai.context'>>;

/** The sentence for an upload that failed: the limit by its number, anything else by its reason. */
function uploadFailure(t: ContextTranslator, file: File, caught: unknown): string {
  if (caught instanceof ApiError && caught.code === 'ai_chat_attachments_limit') {
    const limit = limitOf(caught);
    return limit === null ? caught.message : t('fileTooMany', { count: limit });
  }
  const reason = caught instanceof ApiError ? caught.message : t('fileFailedPlain');
  return t('fileFailed', { name: file.name, reason });
}

/**
 * Uploads files that waited outside any conversation (the start page's field,
 * issue #288) into the one just created for them, one after another, and
 * answers the ids of those that arrived. A file that did not is named through
 * `onError`; the message goes with the rest rather than not at all, because
 * its words were already taken from the field.
 */
export function useChatFileUpload(
  onError: (message: string) => void,
): (conversationId: string, files: readonly File[]) => Promise<string[]> {
  const t = useTranslations('ai.context');
  return React.useCallback(
    async (conversationId, files) => {
      // Files picked on the start page arrive as files and are uploaded into
      // the conversation just made for them (issue #223).
      const ids: string[] = [];
      for (const file of files) {
        try {
          ids.push((await uploadChatFile(conversationId, file)).id);
        } catch (caught) {
          onError(uploadFailure(t, file, caught));
        }
      }
      return ids;
    },
    [onError, t],
  );
}

let counter = 0;
function nextLocalId(): string {
  counter += 1;
  return `chat-file-${String(counter)}`;
}

function limitOf(error: ApiError): number | null {
  const details = error.details as { limit?: unknown } | null | undefined;
  return typeof details?.limit === 'number' ? details.limit : null;
}

/**
 * The pictures and documents for the next message (issue #223).
 *
 * Each one is uploaded the moment it arrives, into the conversation it will be
 * sent in, so the server holds it under the same size and type checks as any
 * upload and the send only names it. A conversation is created first when
 * there is none yet, as pinning a source does.
 *
 * Files belong to the conversation they were uploaded to. When the panel
 * switches to another one they are dropped from the row; the server collects
 * what was never sent.
 */
export function useChatAttachments(input: {
  conversationId: string | null;
  ensureConversation: () => Promise<string>;
  onError: (message: string) => void;
}): ChatAttachments {
  const t = useTranslations('ai.context');
  const [files, setFiles] = React.useState<PendingChatFile[]>([]);
  const [owner, setOwner] = React.useState<string | null>(null);
  // For the two places that need the latest list outside a render: the
  // unmount, which revokes every preview, and `remove`, which deletes one.
  const filesRef = React.useRef(files);
  React.useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Switched to another conversation: what waited here does not go there.
  // Adjusted during render rather than in an effect, so no frame shows the
  // old chips under the new conversation.
  if (owner !== null && input.conversationId !== owner) {
    setOwner(null);
    setFiles([]);
  }

  React.useEffect(
    () => () => {
      for (const file of filesRef.current) URL.revokeObjectURL(file.previewUrl);
    },
    [],
  );

  const { ensureConversation, onError } = input;
  const currentConversation = input.conversationId;

  const add = React.useCallback(
    (incoming: readonly File[]) => {
      const accepted: File[] = [];
      for (const file of incoming) {
        if (isChatFile(file)) accepted.push(file);
        else onError(t('fileNotImage', { name: file.name }));
      }
      if (accepted.length === 0) return;

      const pending = accepted.map((file) => {
        const kind = chatFileKind(file);
        return {
          file,
          entry: {
            localId: nextLocalId(),
            name: file.name,
            kind,
            previewUrl: kind === 'picture' ? URL.createObjectURL(file) : '',
            status: 'uploading' as const,
            attachment: null,
          },
        };
      });
      setFiles((current) => [...current, ...pending.map(({ entry }) => entry)]);

      const drop = (localId: string) =>
        setFiles((current) =>
          current.filter((file) => {
            if (file.localId !== localId) return true;
            URL.revokeObjectURL(file.previewUrl);
            return false;
          }),
        );

      void (async () => {
        let conversationId: string;
        try {
          conversationId = currentConversation ?? (await ensureConversation());
        } catch (caught) {
          onError(caught instanceof ApiError ? caught.message : t('fileFailedPlain'));
          for (const { entry } of pending) drop(entry.localId);
          return;
        }
        setOwner(conversationId);
        // One after another: the server counts what is waiting, and a burst of
        // parallel uploads would all pass that count before any of them landed.
        for (const { file, entry } of pending) {
          try {
            const attachment = await uploadChatFile(conversationId, file);
            setFiles((current) => markReady(current, entry.localId, attachment));
          } catch (caught) {
            drop(entry.localId);
            onError(uploadFailure(t, file, caught));
          }
        }
      })();
    },
    [currentConversation, ensureConversation, onError, t],
  );

  const remove = React.useCallback((localId: string) => {
    const file = filesRef.current.find((candidate) => candidate.localId === localId);
    if (file === undefined) return;
    URL.revokeObjectURL(file.previewUrl);
    setFiles((current) => current.filter((candidate) => candidate.localId !== localId));
    if (file.attachment !== null) {
      // Best effort: what is not deleted now is collected by the nightly sweep.
      void apiRequest(`/api/attachments/${file.attachment.id}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  }, []);

  const sent = React.useCallback(() => {
    setFiles((current) => {
      if (current.length === 0) return current;
      for (const file of current) URL.revokeObjectURL(file.previewUrl);
      return [];
    });
  }, []);

  const readyIds = files.flatMap((file) => (file.attachment === null ? [] : [file.attachment.id]));
  return {
    files,
    add,
    remove,
    uploading: files.some((file) => file.status === 'uploading'),
    readyIds,
    idsFor: (conversationId) => (conversationId === null ? [] : readyIds),
    sent,
  };
}

function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * The AI panel as a drop target for pictures (issue #223). Only a drag that
 * carries files is taken, so a block dragged out of the editor or a link
 * dragged across keeps its own meaning. Enter and leave fire for every child
 * the pointer crosses, so the hint is held by a count rather than a flag.
 */
export function useFileDrop(onFiles: (files: File[]) => void): {
  dragging: boolean;
  handlers: Pick<
    React.HTMLAttributes<HTMLElement>,
    'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'
  >;
} {
  const [depth, setDepth] = React.useState(0);
  return {
    dragging: depth > 0,
    handlers: {
      onDragEnter: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDepth((current) => current + 1);
      },
      onDragOver: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (event) => {
        if (!carriesFiles(event)) return;
        setDepth((current) => Math.max(0, current - 1));
      },
      onDrop: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDepth(0);
        onFiles(Array.from(event.dataTransfer.files));
      },
    },
  };
}
