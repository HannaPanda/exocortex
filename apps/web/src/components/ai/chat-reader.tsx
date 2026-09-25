'use client';

import { ArrowRightIcon, FileTextIcon, TrashIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type AiConversation } from '@exocortex/contracts';
import { Badge, Button, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { useAiConversation } from '@/lib/api/ai-queries';
import { useRelativeTime } from '@/lib/relative-time';

import { Transcript } from './transcript';

export interface ChatReaderProps {
  conversationId: string | null;
  onContinue: (conversation: AiConversation) => void;
  onSaveAsPage: (conversation: AiConversation) => void;
  onDelete: (conversation: AiConversation) => void;
}

/**
 * The reading half of `/chats`: one transcript, without a composer.
 *
 * Built on `Transcript` and `ChatMessage` rather than on a second renderer, so
 * a retired message is dimmed here exactly the way it is in the panel and a
 * context boundary lands in the same place. A reader that formatted the same
 * rows differently would quietly become a second answer to "what was said".
 */
export function ChatReader({
  conversationId,
  onContinue,
  onSaveAsPage,
  onDelete,
}: ChatReaderProps) {
  const t = useTranslations('ai.reader');
  const formatRelativeTime = useRelativeTime();
  const detail = useAiConversation(conversationId);

  if (conversationId === null) {
    return <EmptyState title={t('noneTitle')} description={t('noneDescription')} />;
  }
  if (detail.isPending) return <LoadingState variant="skeleton" rows={6} />;
  if (detail.isError || detail.data === undefined) {
    return (
      <ErrorState
        title={t('unavailableTitle')}
        description={t('unavailableDescription')}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const { conversation, messages } = detail.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-reader">
      <header className="flex flex-col gap-2 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{conversation.title}</h2>
          {conversation.archivedAt === null ? null : (
            <Badge variant="secondary">{t('archived')}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('messages', { count: conversation.messageCount })}
          {' · '}
          {formatRelativeTime(conversation.lastMessageAt)}
          {conversation.modelSlug === null ? null : ` · ${conversation.modelSlug}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" data-testid="chat-continue" onClick={() => onContinue(conversation)}>
            <ArrowRightIcon /> {t('continue')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="chat-to-page"
            onClick={() => onSaveAsPage(conversation)}
          >
            <FileTextIcon /> {t('saveAsPage')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="chat-delete"
            onClick={() => onDelete(conversation)}
          >
            <TrashIcon /> {t('delete')}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" data-testid="chat-transcript">
        {messages.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <Transcript messages={messages} />
        )}
      </div>
    </div>
  );
}
