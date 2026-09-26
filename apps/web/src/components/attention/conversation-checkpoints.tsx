'use client';

import { useTranslations } from 'next-intl';

import { useAttention } from '@/lib/api/attention-queries';

import { AttentionCard } from './attention-card';

/**
 * The questions a chat's runs are waiting on, under its transcript (issue
 * #140). The run that asked has ended; answering here is the same act as
 * answering in the inbox, and the answer arrives in this chat as the next
 * message, which is where the work goes on. Nothing at all while nothing
 * waits.
 */
export function ConversationCheckpoints({ conversationId }: { conversationId: string | null }) {
  const t = useTranslations('attention.conversation');
  const open = useAttention(
    { status: 'open', conversationId: conversationId ?? undefined },
    { enabled: conversationId !== null },
  );
  const items = conversationId === null ? [] : (open.data?.attentionItems ?? []);
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby={`conversation-checkpoints-${conversationId}`}
      className="flex flex-col gap-2"
      data-testid="conversation-checkpoints"
    >
      <h2 id={`conversation-checkpoints-${conversationId}`} className="text-sm font-medium">
        {t('title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('intro')}</p>
      {items.map((item) => (
        <AttentionCard key={item.id} item={item} />
      ))}
    </section>
  );
}
