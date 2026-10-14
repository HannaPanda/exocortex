'use client';

import { useTranslations } from 'next-intl';

import { SectionRule } from '@exocortex/ui';

import { useAttention } from '@/lib/api/attention-queries';

import { AttentionCard } from './attention-card';

/**
 * What this piece of work waits on the reader for, at the top of its page
 * (issue #139). The same cards as the inbox, so an answer given here and one
 * given there are the same act; nothing at all while nothing waits.
 */
export function WorkItemAttention({ workItemId }: { workItemId: string }) {
  const t = useTranslations('attention.workItem');
  const open = useAttention({ status: 'open', workItemId });
  const items = open.data?.attentionItems ?? [];
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center">
        <SectionRule trailing={items.length}>{t('title')}</SectionRule>
      </div>
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {items.map((item) => (
        <AttentionCard key={item.id} item={item} showWorkspace={false} />
      ))}
    </section>
  );
}
