'use client';

import Link from 'next/link';
import * as React from 'react';

import { type AiConversation, type ParentSuggestion } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  LoadingState,
} from '@exocortex/ui';

import { useConversationToPage } from '@/lib/api/ai-queries';
import { useSuggestParentForTitle } from '@/lib/api/placement-queries';

/**
 * Saving a chat as a page (issue #69, AP5).
 *
 * The parent is chosen, never guessed: where a page hangs is part of what it
 * says, and a transcript dropped at the root of a workspace is the filing
 * mistake the placement tools exist to prevent. The suggestions come from the
 * same endpoint `exo_page_suggest_parent` uses, asked with the title and the
 * first lines rather than with a document id, because the page does not exist
 * yet.
 */
export function ChatSaveDialog({
  conversation,
  onClose,
}: {
  conversation: AiConversation | null;
  onClose: () => void;
}) {
  // Seeded from the conversation rather than synchronized to it: the caller
  // keys this component on the conversation id, so choosing another one
  // remounts it and the fields start over. An effect that pushed the new title
  // into state would be a render behind on the first paint.
  const [title, setTitle] = React.useState(conversation?.title ?? '');
  const [parentId, setParentId] = React.useState<string | null>(null);
  const toPage = useConversationToPage();

  const suggestions = useSuggestParentForTitle({
    workspaceId: conversation?.workspaceId ?? null,
    title: conversation?.title ?? '',
    summary: conversation?.preview ?? '',
    enabled: conversation !== null,
  });

  const save = (): void => {
    if (conversation === null) return;
    void toPage.mutateAsync({
      conversationId: conversation.id,
      request: { parentId, title: title.trim().length === 0 ? undefined : title.trim() },
    });
  };

  const saved = toPage.data ?? null;

  return (
    <Dialog
      open={conversation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chat als Seite sichern</DialogTitle>
          <DialogDescription>
            Der Verlauf wird als Seite angelegt. Die Unterhaltung selbst bleibt, wie sie ist.
          </DialogDescription>
        </DialogHeader>

        {saved === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="chat-save-title">Titel</Label>
              <Input
                id="chat-save-title"
                value={title}
                data-testid="chat-save-title"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Wohin</span>
              {suggestions.isPending ? (
                <LoadingState variant="skeleton" rows={2} />
              ) : (
                <ParentChoice
                  parentId={parentId}
                  suggestions={suggestions.data?.suggestions ?? []}
                  onChange={setParentId}
                />
              )}
            </div>

            {toPage.isError ? (
              <p className="text-xs text-destructive-text">{toPage.error.message}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm" data-testid="chat-save-done">
            Gesichert als{' '}
            <Link
              href={`/arbeitsbereich/${saved.workspaceId}/seite/${saved.documentId}`}
              className="underline underline-offset-2"
            >
              {saved.title}
            </Link>
            .
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {saved === null ? 'Abbrechen' : 'Schließen'}
          </Button>
          {saved === null ? (
            <Button onClick={save} disabled={toPage.isPending} data-testid="chat-save-submit">
              Sichern
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The root plus up to three suggested parents, each naming what already lives there. */
function ParentChoice({
  parentId,
  suggestions,
  onChange,
}: {
  parentId: string | null;
  suggestions: readonly ParentSuggestion[];
  onChange: (parentId: string | null) => void;
}) {
  const options: { id: string | null; label: string; hint: string }[] = [
    { id: null, label: 'Oberste Ebene', hint: 'Direkt im Arbeitsbereich' },
    ...suggestions
      .filter((suggestion) => suggestion.parentId !== null)
      .map((suggestion) => ({
        id: suggestion.parentId,
        label: suggestion.title,
        hint:
          suggestion.path.length === 0
            ? `${String(suggestion.childCount)} Unterseiten`
            : `${suggestion.path.map((entry) => entry.title).join(' › ')} · ${String(suggestion.childCount)} Unterseiten`,
      })),
  ];

  return (
    <div className="flex flex-col gap-1" data-testid="chat-save-parents">
      {options.map((option) => (
        <button
          key={option.id ?? 'root'}
          type="button"
          aria-pressed={parentId === option.id}
          onClick={() => onChange(option.id)}
          className={
            parentId === option.id
              ? 'rounded-md border border-primary bg-accent px-2 py-1.5 text-left'
              : 'rounded-md border border-border px-2 py-1.5 text-left hover:bg-accent'
          }
        >
          <span className="block text-sm">{option.label}</span>
          <span className="block text-xs text-muted-foreground">{option.hint}</span>
        </button>
      ))}
    </div>
  );
}
