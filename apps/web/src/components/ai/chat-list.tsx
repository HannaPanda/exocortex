'use client';

import { ArchiveIcon, ArchiveRestoreIcon, PencilIcon } from 'lucide-react';
import * as React from 'react';

import { type AiConversation, type AiConversationSearchHit } from '@exocortex/contracts';
import { Badge, Button, cn } from '@exocortex/ui';

import { formatRelativeTime } from '@/lib/relative-time';

export interface ChatListProps {
  conversations: readonly AiConversation[];
  /** Keyed by conversation id when the list is showing search results. */
  snippets: ReadonlyMap<string, AiConversationSearchHit>;
  workspaceNames: ReadonlyMap<string, string>;
  selectedId: string | null;
  onSelect: (conversation: AiConversation) => void;
  onRename: (conversation: AiConversation) => void;
  onToggleArchived: (conversation: AiConversation) => void;
}

/**
 * The left half of `/chats`: one row per conversation.
 *
 * A row says enough to recognize a conversation without opening it -- what was
 * asked first, which workspace and page it happened on, how long ago. When the
 * list is a search result the first user line is replaced by the passage that
 * matched, because that is the reason the row is on screen.
 */
export function ChatList({
  conversations,
  snippets,
  workspaceNames,
  selectedId,
  onSelect,
  onRename,
  onToggleArchived,
}: ChatListProps) {
  return (
    <ul className="flex flex-col gap-1" data-testid="chat-list">
      {conversations.map((conversation) => (
        <ChatRow
          key={conversation.id}
          conversation={conversation}
          hit={snippets.get(conversation.id) ?? null}
          workspaceName={workspaceNames.get(conversation.workspaceId) ?? null}
          selected={conversation.id === selectedId}
          onSelect={onSelect}
          onRename={onRename}
          onToggleArchived={onToggleArchived}
        />
      ))}
    </ul>
  );
}

function ChatRow({
  conversation,
  hit,
  workspaceName,
  selected,
  onSelect,
  onRename,
  onToggleArchived,
}: {
  conversation: AiConversation;
  hit: AiConversationSearchHit | null;
  workspaceName: string | null;
  selected: boolean;
  onSelect: (conversation: AiConversation) => void;
  onRename: (conversation: AiConversation) => void;
  onToggleArchived: (conversation: AiConversation) => void;
}) {
  const archived = conversation.archivedAt !== null;
  const facts = [
    workspaceName,
    conversation.documentTitle,
    conversation.modelSlug,
    formatRelativeTime(conversation.lastMessageAt),
  ].filter((fact): fact is string => fact !== null && fact.length > 0);

  return (
    <li data-testid="chat-row">
      <div
        className={cn(
          'flex items-start gap-2 rounded-md border p-2',
          selected ? 'border-primary bg-accent' : 'border-border hover:bg-accent',
        )}
      >
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          aria-current={selected ? 'true' : undefined}
          data-testid="chat-row-open"
          onClick={() => onSelect(conversation)}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-words">{conversation.title}</span>
            {archived ? <Badge variant="secondary">archiviert</Badge> : null}
            {hit === null || hit.matchCount === 1 ? null : (
              <span className="text-xs text-muted-foreground">
                {String(hit.matchCount)} Treffer
              </span>
            )}
          </span>
          {hit === null ? (
            conversation.preview.length === 0 ? null : (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {conversation.preview}
              </span>
            )
          ) : (
            <Snippet html={hit.snippet} superseded={hit.messageSuperseded} />
          )}
          <span className="mt-1 block text-xs text-muted-foreground">{facts.join(' · ')}</span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Umbenennen"
            data-testid="chat-rename"
            onClick={() => onRename(conversation)}
          >
            <PencilIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={archived ? 'Wiederherstellen' : 'Archivieren'}
            data-testid="chat-archive"
            onClick={() => onToggleArchived(conversation)}
          >
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * `ts_headline` output: the matching passage with `<mark>` around the terms.
 *
 * The only markup PostgreSQL is allowed to have put there is `<mark>`, and the
 * only way to be sure of that is to build the elements rather than to trust the
 * string: the text between the markers is a person's own message, and one
 * containing `<script>` would otherwise be rendered as one.
 */
function Snippet({ html, superseded }: { html: string; superseded: boolean }) {
  const parts = html.split(/<mark>|<\/mark>/);
  return (
    <span
      className={cn(
        'mt-0.5 block text-xs',
        superseded ? 'text-muted-foreground/70' : 'text-muted-foreground',
      )}
      data-testid="chat-snippet"
    >
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        ),
      )}
      {superseded ? ' (nicht mehr im Kontext)' : ''}
    </span>
  );
}
