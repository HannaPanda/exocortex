'use client';

import { ArchiveIcon, ChevronDownIcon, ListIcon, PencilIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type AiConversation } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@exocortex/ui';

import {
  PANEL_CONVERSATION_LIMIT,
  useAiConversations,
  useArchiveAiConversation,
  useUpdateAiConversation,
} from '@/lib/api/ai-queries';
import { formatRelativeTime } from '@/lib/relative-time';

export interface ConversationSwitcherProps {
  workspaceId: string;
  activeConversationId: string | null;
  onSelect: (conversationId: string | null) => void;
  onCreateNew: () => void;
}

/**
 * Dropdown to switch between, rename and archive the most recent conversations,
 * plus start a new one.
 *
 * Five, not twenty (issue #69). A dropdown is for "the one I was just in"; it
 * was never a way to find a conversation from three weeks ago, and pretending
 * otherwise is what kept the chat history unreachable. Everything past the last
 * few lives in `/chats`, which this menu links to.
 */
export function ConversationSwitcher({
  workspaceId,
  activeConversationId,
  onSelect,
  onCreateNew,
}: ConversationSwitcherProps) {
  const conversations = useAiConversations(workspaceId);
  const updateConversation = useUpdateAiConversation();
  const archiveConversation = useArchiveAiConversation();

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState<AiConversation | null>(null);
  const [renameValue, setRenameValue] = React.useState('');

  const list = conversations.data ?? [];
  const visible = list.slice(0, PANEL_CONVERSATION_LIMIT);
  const active = list.find((conversation) => conversation.id === activeConversationId) ?? null;

  const archive = async (conversation: AiConversation): Promise<void> => {
    await archiveConversation.mutateAsync({ conversationId: conversation.id, workspaceId });
    if (conversation.id !== activeConversationId) return;

    const remaining = list
      .filter((entry) => entry.id !== conversation.id)
      .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
    onSelect(remaining[0]?.id ?? null);
  };

  const submitRename = async (): Promise<void> => {
    if (renaming === null) return;
    const title = renameValue.trim();
    if (title.length === 0) {
      setRenaming(null);
      return;
    }
    await updateConversation.mutateAsync({ conversationId: renaming.id, request: { title } });
    setRenaming(null);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 gap-1"
              data-testid="ai-conversation-switcher"
            >
              <span className="max-w-[14rem] truncate">{active?.title ?? 'Neuer Chat'}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem
            data-testid="ai-new-conversation"
            onClick={() => {
              setMenuOpen(false);
              onCreateNew();
            }}
          >
            <PlusIcon /> Neuer Chat
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="ai-all-conversations"
            render={<Link href="/chats" />}
            onClick={() => setMenuOpen(false)}
          >
            <ListIcon /> Alle Chats
          </DropdownMenuItem>
          {visible.length > 0 ? <DropdownMenuSeparator /> : null}
          {visible.map((conversation) => (
            <div key={conversation.id} className="flex items-center gap-0.5">
              <DropdownMenuItem
                className="min-w-0 flex-1"
                onClick={() => {
                  setMenuOpen(false);
                  onSelect(conversation.id);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTime(conversation.lastMessageAt)}
                </span>
              </DropdownMenuItem>
              <button
                type="button"
                aria-label="Umbenennen"
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setRenaming(conversation);
                  setRenameValue(conversation.title);
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label="Archivieren"
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  void archive(conversation);
                }}
              >
                <ArchiveIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Chat umbenennen</DialogTitle>
          </DialogHeader>
          <label htmlFor="ai-conversation-rename" className="sr-only">
            Neuer Titel
          </label>
          <Input
            id="ai-conversation-rename"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitRename();
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Abbrechen
            </Button>
            <Button onClick={() => void submitRename()} disabled={renameValue.trim().length === 0}>
              Speichern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
