'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import {
  type AiConversation,
  type AiConversationArchivedFilter,
  type AiConversationSearchHit,
} from '@exocortex/contracts';
import {
  AppPage,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  CONTEXT_DEFAULT,
  CONTEXT_STORAGE_KEY,
  parsePanelPreference,
} from '@/components/shell/panel-preferences';
import {
  useAiConversation,
  useArchiveAiConversation,
  useChats,
  useChatSearch,
  useDeleteAiConversation,
  useUpdateAiConversation,
} from '@/lib/api/ai-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { usePersistentState, writePersistentState } from '@/lib/use-persistent-state';

import { ChatList } from './chat-list';
import { ChatReader } from './chat-reader';
import { ChatSaveDialog } from './chat-save-dialog';
import { activeConversationKey } from './panel-state';

/**
 * `/chats`: the place a conversation can be found again (issue #69).
 *
 * The chat history used to live only in the panel's dropdown, which showed the
 * twenty most recent titles of one workspace and had no search. It was the one
 * kind of content in eXocortex that could be written and never retrieved.
 *
 * Deliberately its own top-level area rather than a virtual workspace: a
 * conversation is personal where a workspace is shared, it is an append-only
 * list of rows where a workspace holds documents with Yjs state (ADR-004/005),
 * and `Workspace.isMemory` is meant to stay the single special case (ADR-023).
 * The reasoning is written out in the issue.
 */

const ARCHIVED_LABELS: Record<AiConversationArchivedFilter, string> = {
  open: 'Offene',
  archived: 'Archivierte',
  all: 'Alle',
};

const SEARCH_DEBOUNCE_MS = 300;

export function ChatsPage() {
  const router = useRouter();
  const params = useSearchParams();

  const [query, setQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [archived, setArchived] = React.useState<AiConversationArchivedFilter>('open');
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<AiConversation | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [deleting, setDeleting] = React.useState<AiConversation | null>(null);
  const [saving, setSaving] = React.useState<AiConversation | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const workspaces = useWorkspaces();
  const workspaceNames = React.useMemo(
    () => new Map((workspaces.data ?? []).map((workspace) => [workspace.id, workspace.name])),
    [workspaces.data],
  );

  // A search reaches every workspace and both halves of the archive by default:
  // the chat somebody is looking for is as likely to be an archived one, and
  // making them find the right filter first is the problem, not the solution.
  const searching = debouncedQuery.trim().length > 0;
  const search = useChatSearch(debouncedQuery, searching ? 'all' : archived);
  const chats = useChats({ workspaceId, archived });

  const listed = React.useMemo<AiConversation[]>(() => {
    if (searching) {
      return (search.data?.hits ?? [])
        .map((hit) => hit.conversation)
        .filter((conversation) => workspaceId === null || conversation.workspaceId === workspaceId);
    }
    return (chats.data?.pages ?? []).flatMap((page) => page.conversations);
  }, [searching, search.data, chats.data, workspaceId]);

  const snippets = React.useMemo<Map<string, AiConversationSearchHit>>(
    () =>
      searching
        ? new Map((search.data?.hits ?? []).map((hit) => [hit.conversation.id, hit]))
        : new Map(),
    [searching, search.data],
  );

  const [context, setContext] = usePersistentState(
    CONTEXT_STORAGE_KEY,
    CONTEXT_DEFAULT,
    parsePanelPreference,
  );

  /**
   * Hands a conversation back to the panel and goes where it can be seen.
   *
   * Three steps, and all three are needed: the panel reads its active
   * conversation out of `localStorage` per workspace, the context panel has to
   * be open for it to be on screen at all, and the panel only renders inside a
   * workspace route -- on the page the conversation was standing on, when it
   * still has one.
   */
  const continueInPanel = React.useCallback(
    (conversation: AiConversation): void => {
      writePersistentState(activeConversationKey(conversation.workspaceId), conversation.id);
      if (!context.open) setContext({ ...context, open: true });
      router.push(
        conversation.documentId === null
          ? `/arbeitsbereich/${conversation.workspaceId}`
          : `/arbeitsbereich/${conversation.workspaceId}/seite/${conversation.documentId}`,
      );
    },
    [context, router, setContext],
  );

  /**
   * `/chats?fortsetzen=<id>` is the same action as the button, as a link.
   *
   * Asked of the API rather than looked up in `listed`, so it works for a
   * conversation the current filters exclude -- an archived one, or one in
   * another workspace. Until the answer arrives the id is what the reader
   * shows, so the link does something visible either way.
   */
  const requested = params.get('fortsetzen');
  const requestedDetail = useAiConversation(requested);
  const handledContinue = React.useRef<string | null>(null);
  React.useEffect(() => {
    const conversation = requestedDetail.data?.conversation ?? null;
    if (requested === null || conversation === null) return;
    if (handledContinue.current === requested) return;
    handledContinue.current = requested;
    continueInPanel(conversation);
  }, [requested, requestedDetail.data, continueInPanel]);

  const shownId = selectedId ?? requested;

  const updateConversation = useUpdateAiConversation();
  const archiveConversation = useArchiveAiConversation();
  const deleteConversation = useDeleteAiConversation();

  const toggleArchived = (conversation: AiConversation): void => {
    if (conversation.archivedAt === null) {
      void archiveConversation.mutateAsync({
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
      });
      return;
    }
    void updateConversation.mutateAsync({
      conversationId: conversation.id,
      request: { archived: false },
    });
  };

  const submitRename = (): void => {
    if (renaming === null) return;
    const title = renameValue.trim();
    if (title.length > 0) {
      void updateConversation.mutateAsync({ conversationId: renaming.id, request: { title } });
    }
    setRenaming(null);
  };

  const confirmDelete = (): void => {
    if (deleting === null) return;
    void deleteConversation
      .mutateAsync({ conversationId: deleting.id, workspaceId: deleting.workspaceId })
      .then(() => {
        if (selectedId === deleting.id) setSelectedId(null);
        setDeleting(null);
      });
  };

  const loading = searching ? search.isPending : chats.isPending;

  return (
    <AppPage maxWidth="max-w-6xl">
      <div>
        <h1 className="exocortex-page-title">Chats</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">
          Alle KI-Unterhaltungen, über die Arbeitsbereiche hinweg. Die Suche geht über den
          Nachrichtentext, nicht nur über die Titel.
        </p>
      </div>

      <ChatFilters
        query={query}
        onQueryChange={setQuery}
        archived={archived}
        onArchivedChange={setArchived}
        searching={searching}
        workspaceId={workspaceId}
        onWorkspaceChange={setWorkspaceId}
        workspaces={workspaces.data ?? []}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0">
          {loading ? (
            <LoadingState label="Chats werden geladen …" />
          ) : listed.length === 0 ? (
            <EmptyState
              title={searching ? 'Nichts gefunden' : 'Keine Chats'}
              description={
                searching
                  ? 'Kein Verlauf enthält diese Wörter. Auch archivierte Chats wurden durchsucht.'
                  : 'Sobald du im Panel etwas fragst, taucht die Unterhaltung hier auf.'
              }
            />
          ) : (
            <>
              <ChatList
                conversations={listed}
                snippets={snippets}
                workspaceNames={workspaceNames}
                selectedId={shownId}
                onSelect={(conversation) => setSelectedId(conversation.id)}
                onRename={(conversation) => {
                  setRenaming(conversation);
                  setRenameValue(conversation.title);
                }}
                onToggleArchived={toggleArchived}
              />
              {!searching && chats.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  data-testid="chat-load-more"
                  disabled={chats.isFetchingNextPage}
                  onClick={() => void chats.fetchNextPage()}
                >
                  Mehr laden
                </Button>
              ) : null}
            </>
          )}
        </div>

        <div className="flex min-h-[24rem] min-w-0 flex-col rounded-md border border-border">
          <ChatReader
            conversationId={shownId}
            onContinue={continueInPanel}
            onSaveAsPage={setSaving}
            onDelete={setDeleting}
          />
        </div>
      </div>

      <RenameDialog
        open={renaming !== null}
        value={renameValue}
        onValueChange={setRenameValue}
        onClose={() => setRenaming(null)}
        onSubmit={submitRename}
      />

      <DeleteDialog
        conversation={deleting}
        pending={deleteConversation.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />

      {/* Keyed on the conversation: choosing another one remounts the dialog,
          which is how its fields start over without an effect. */}
      <ChatSaveDialog
        key={saving?.id ?? 'none'}
        conversation={saving}
        onClose={() => setSaving(null)}
      />
    </AppPage>
  );
}

function ChatFilters({
  query,
  onQueryChange,
  archived,
  onArchivedChange,
  searching,
  workspaceId,
  onWorkspaceChange,
  workspaces,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  archived: AiConversationArchivedFilter;
  onArchivedChange: (value: AiConversationArchivedFilter) => void;
  searching: boolean;
  workspaceId: string | null;
  onWorkspaceChange: (value: string | null) => void;
  workspaces: readonly { id: string; name: string }[];
}) {
  return (
    <div className="mt-6 flex flex-wrap items-end gap-3">
      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
        <Label htmlFor="chat-search">Suchen</Label>
        <Input
          id="chat-search"
          value={query}
          placeholder="Wort aus dem Verlauf …"
          data-testid="chat-search"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="chat-workspace">Arbeitsbereich</Label>
        <Select
          value={workspaceId ?? 'all'}
          onValueChange={(next) => onWorkspaceChange(next === 'all' ? null : next)}
        >
          <SelectTrigger id="chat-workspace" className="w-52" data-testid="chat-workspace">
            <SelectValue>
              {() =>
                workspaceId === null
                  ? 'Alle'
                  : (workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? 'Alle')
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="chat-archived">Zustand</Label>
        <Select
          value={archived}
          onValueChange={(next) => onArchivedChange(next as AiConversationArchivedFilter)}
        >
          <SelectTrigger
            id="chat-archived"
            className="w-40"
            disabled={searching}
            data-testid="chat-archived"
          >
            <SelectValue>{() => (searching ? 'Alle' : ARCHIVED_LABELS[archived])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(['open', 'archived', 'all'] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {ARCHIVED_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function RenameDialog({
  open,
  value,
  onValueChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unterhaltung umbenennen</DialogTitle>
        </DialogHeader>
        <label htmlFor="chat-rename-title" className="sr-only">
          Neuer Titel
        </label>
        <Input
          id="chat-rename-title"
          value={value}
          data-testid="chat-rename-input"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={onSubmit} disabled={value.trim().length === 0}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The one action here that no snapshot brings back, so it asks first. */
function DeleteDialog({
  conversation,
  pending,
  onClose,
  onConfirm,
}: {
  conversation: AiConversation | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={conversation !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Endgültig löschen</DialogTitle>
          <DialogDescription>
            „{conversation?.title}“ wird mit allen Nachrichten gelöscht. Das lässt sich nicht
            rückgängig machen. Archivieren behält den Verlauf und blendet ihn nur aus.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            data-testid="chat-delete-confirm"
            onClick={onConfirm}
          >
            Endgültig löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
