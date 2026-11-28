'use client';

import { ArchiveIcon, ChevronDownIcon, ListIcon, PencilIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiConversation } from '@exocortex/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import {
  PANEL_CONVERSATION_LIMIT,
  useAiConversations,
  useArchiveAiConversation,
} from '@/lib/api/ai-queries';
import { useRelativeTime } from '@/lib/relative-time';

import { ConversationRenameDialog } from './conversation-rename-dialog';

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
  const t = useTranslations('ai.conversations');
  const formatRelativeTime = useRelativeTime();
  const conversations = useAiConversations(workspaceId);
  const archiveConversation = useArchiveAiConversation();

  const [menuOpen, setMenuOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState<AiConversation | null>(null);

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
              <span className="max-w-[14rem] truncate">{active?.title ?? t('newChat')}</span>
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
            <PlusIcon /> {t('newChat')}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="ai-all-conversations"
            render={<Link href="/chats" />}
            onClick={() => setMenuOpen(false)}
          >
            <ListIcon /> {t('allChats')}
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
                aria-label={t('rename')}
                className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setRenaming(conversation);
                }}
              >
                <PencilIcon className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t('archive')}
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

      <ConversationRenameDialog conversation={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}
