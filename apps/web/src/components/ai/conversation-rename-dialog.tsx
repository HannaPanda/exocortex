'use client';

import { Loader2Icon, SparklesIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiConversation } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@exocortex/ui';

import { useSuggestAiConversationTitle, useUpdateAiConversation } from '@/lib/api/ai-queries';

export interface ConversationRenameDialogProps {
  /** The conversation being renamed; `null` keeps the dialog closed. */
  conversation: AiConversation | null;
  onClose: () => void;
}

type SuggestionNote =
  | { kind: 'none' }
  | { kind: 'suggested' }
  | {
      kind: 'failed';
      reason: 'nothing_to_name' | 'provider_failed' | 'key_unreadable' | 'timed_out' | 'error';
    };

/**
 * Renaming a chat, in the panel's switcher and on `/chats` alike.
 *
 * The button beside the field asks for a title from the conversation itself
 * (issue #233) and puts it into the field, selected, so it can be kept, edited
 * or typed over. Nothing is stored until the person saves: a suggestion never
 * replaces a title somebody chose, and there is no automatic renaming at all.
 */
export function ConversationRenameDialog({ conversation, onClose }: ConversationRenameDialogProps) {
  return (
    <Dialog open={conversation !== null} onOpenChange={(open) => !open && onClose()}>
      {conversation === null ? null : (
        // Keyed on the conversation, so the field and the note start over
        // for every chat without an effect resetting them.
        <RenameForm key={conversation.id} conversation={conversation} onClose={onClose} />
      )}
    </Dialog>
  );
}

function RenameForm({
  conversation,
  onClose,
}: {
  conversation: AiConversation;
  onClose: () => void;
}) {
  const t = useTranslations('ai.conversations');
  const updateConversation = useUpdateAiConversation();
  const suggestTitle = useSuggestAiConversationTitle();
  const [value, setValue] = React.useState(conversation.title);
  const [note, setNote] = React.useState<SuggestionNote>({ kind: 'none' });
  const inputRef = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  const noteId = React.useId();

  const submit = async (): Promise<void> => {
    const title = value.trim();
    if (title.length > 0 && title !== conversation.title) {
      await updateConversation.mutateAsync({ conversationId: conversation.id, request: { title } });
    }
    onClose();
  };

  const suggest = async (): Promise<void> => {
    setNote({ kind: 'none' });
    try {
      const response = await suggestTitle.mutateAsync({ conversationId: conversation.id });
      if (response.suggestion.outcome === 'failed') {
        setNote({ kind: 'failed', reason: response.suggestion.reason });
        return;
      }
      setValue(response.suggestion.title);
      setNote({ kind: 'suggested' });
      // Selected, so typing replaces it and an arrow key starts editing it.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } catch {
      setNote({ kind: 'failed', reason: 'error' });
    }
  };

  const pending = suggestTitle.isPending;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('renameTitle')}</DialogTitle>
        <DialogDescription>{t('suggestTitleHint')}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {t('newTitle')}
        </label>
        <Input
          ref={inputRef}
          id={inputId}
          className="min-w-48 flex-1"
          value={value}
          maxLength={160}
          data-testid="chat-rename-input"
          aria-describedby={note.kind === 'none' ? undefined : noteId}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          autoFocus
        />
        <Button
          type="button"
          variant="outline"
          data-testid="chat-rename-suggest"
          disabled={pending}
          aria-busy={pending}
          onClick={() => void suggest()}
        >
          {pending ? (
            <Loader2Icon className="motion-safe:animate-spin" aria-hidden />
          ) : (
            <SparklesIcon aria-hidden />
          )}
          {pending ? t('suggestingTitle') : t('suggestTitle')}
        </Button>
      </div>
      <p
        id={noteId}
        aria-live="polite"
        data-testid="chat-rename-note"
        className={
          note.kind === 'failed'
            ? 'min-h-5 text-sm text-destructive-text'
            : 'min-h-5 text-sm text-muted-foreground'
        }
      >
        {note.kind === 'suggested'
          ? t('suggestedTitle')
          : note.kind === 'failed'
            ? t(`suggestTitleFailed.${note.reason}`)
            : null}
      </p>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          data-testid="chat-rename-save"
          onClick={() => void submit()}
          disabled={value.trim().length === 0 || updateConversation.isPending}
        >
          {t('save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
