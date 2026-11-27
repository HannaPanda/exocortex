'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn } from '@exocortex/ui';

import { ChatComposer } from './chat-composer';
import { ChatFileChip } from './chat-file-chip';
import { useChatStart } from './chat-start';
import {
  chatFileKind,
  isChatFile,
  type PendingChatFile,
  useFileDrop,
} from './use-chat-attachments';

/**
 * The field on a workspace's start page that begins a chat (issue #288).
 *
 * Typing here and pressing Enter starts a new conversation about no page and
 * gives it the screen, which is what asking something quickly on a phone
 * needs. The field only hands the question over: the panel creates the
 * conversation and streams the answer (`chat-start.tsx`).
 *
 * Pictures and documents (issue #223) wait here as local files, because there
 * is no conversation yet to upload them into; the panel uploads them into the
 * one it creates and sends the message with them.
 */
export function ChatStarter({ workspaceId }: { workspaceId: string }) {
  const { start } = useChatStart();
  const t = useTranslations('ai.composer');
  const local = useLocalChatFiles();
  const fileDrop = useFileDrop(local.add);

  return (
    <div
      className={cn(
        'mb-10 rounded-md',
        fileDrop.dragging && 'bg-accent/40 outline-2 outline-primary outline-dashed',
      )}
      data-testid="chat-starter"
      {...fileDrop.handlers}
    >
      {fileDrop.dragging ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground" data-testid="chat-start-drop-hint">
          {t('dropHint')}
        </p>
      ) : null}
      {local.error === null ? null : (
        <p
          className="px-1 pb-1 text-sm text-destructive"
          role="alert"
          data-testid="chat-start-error"
        >
          {local.error}
        </p>
      )}
      {local.pending.length === 0 ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 pb-2">
          {local.pending.map((file) => (
            <ChatFileChip
              key={file.localId}
              file={file}
              disabled={false}
              onRemove={() => local.remove(file.localId)}
            />
          ))}
        </div>
      )}
      <ChatComposer
        variant="start"
        waiting={false}
        onSubmit={(text, { keepFocus }) =>
          start({ workspaceId, text, files: local.take(), focus: keepFocus })
        }
        files={{ onFiles: local.add, ready: local.pending.length > 0, uploading: false }}
      />
    </div>
  );
}

/** Files picked before any conversation exists, with the chips that show them. */
function useLocalChatFiles(): {
  pending: PendingChatFile[];
  error: string | null;
  add: (files: readonly File[]) => void;
  remove: (localId: string) => void;
  /** The files for the message being sent; the row is empty after. */
  take: () => File[];
} {
  const t = useTranslations('ai.context');
  const [entries, setEntries] = React.useState<{ chip: PendingChatFile; file: File }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const entriesRef = React.useRef(entries);
  React.useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  React.useEffect(
    () => () => {
      for (const { chip } of entriesRef.current) URL.revokeObjectURL(chip.previewUrl);
    },
    [],
  );

  const add = React.useCallback(
    (incoming: readonly File[]) => {
      const refused = incoming.find((file) => !isChatFile(file));
      setError(refused === undefined ? null : t('fileNotImage', { name: refused.name }));
      const accepted = incoming.filter(isChatFile).map((file) => {
        const kind = chatFileKind(file);
        return {
          file,
          chip: {
            localId: `start-${String(Date.now())}-${file.name}-${String(Math.random())}`,
            name: file.name,
            kind,
            previewUrl: kind === 'picture' ? URL.createObjectURL(file) : '',
            status: 'ready' as const,
            attachment: null,
          },
        };
      });
      if (accepted.length > 0) setEntries((current) => [...current, ...accepted]);
    },
    [t],
  );

  const remove = React.useCallback((localId: string) => {
    setEntries((current) =>
      current.filter(({ chip }) => {
        if (chip.localId !== localId) return true;
        URL.revokeObjectURL(chip.previewUrl);
        return false;
      }),
    );
  }, []);

  const take = React.useCallback((): File[] => {
    const files = entriesRef.current.map(({ file }) => file);
    for (const { chip } of entriesRef.current) URL.revokeObjectURL(chip.previewUrl);
    entriesRef.current = [];
    setEntries([]);
    setError(null);
    return files;
  }, []);

  return { pending: entries.map(({ chip }) => chip), error, add, remove, take };
}
