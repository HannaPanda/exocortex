'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { ATTENTION_KINDS } from '@exocortex/contracts';
import { AppPage, EmptyState, ErrorState, LoadingState, Toggle, ToggleGroup } from '@exocortex/ui';

import { useAttention } from '@/lib/api/attention-queries';

import { AttentionCard } from './attention-card';

/**
 * What waits on the reader, across every workspace (issue #139, ADR-067).
 *
 * One column of cards rather than a table: every entry carries its own
 * buttons, and a decision needs its reason beside it, which a row would
 * truncate. Open entries come urgent first and then oldest first, because
 * the one that has waited longest is the one somebody is waiting on. The
 * summary line counts by kind, so "3 Entscheidungen, 1 Lauf gescheitert"
 * says how much there is before one card is read.
 */

type Filter = 'open' | 'settled';

export function AttentionPage() {
  const t = useTranslations('attention.page');
  const [filter, setFilter] = React.useState<Filter>('open');
  const items = useAttention({ status: filter });
  const counts = items.data?.openCounts;
  const summary =
    counts === undefined
      ? []
      : ATTENTION_KINDS.filter((kind) => counts[kind] > 0).map((kind) =>
          t(`summary.${kind}`, { count: counts[kind] }),
        );

  return (
    <AppPage maxWidth="max-w-3xl">
      <h1 className="exocortex-page-title">{t('title')}</h1>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <ToggleGroup
          aria-label={t('filterLabel')}
          value={[filter]}
          onValueChange={(next: string[]) => {
            const chosen = next[0];
            if (chosen === 'open' || chosen === 'settled') setFilter(chosen);
          }}
        >
          <Toggle value="open" variant="outline" size="sm">
            {t('filters.open')}
          </Toggle>
          <Toggle value="settled" variant="outline" size="sm">
            {t('filters.settled')}
          </Toggle>
        </ToggleGroup>
        {summary.length === 0 ? null : (
          <p
            className="text-sm text-muted-foreground"
            aria-label={t('summaryLabel')}
            data-testid="attention-summary"
          >
            {summary.join(' · ')}
          </p>
        )}
      </div>

      <section className="mt-4" aria-live="polite">
        {items.isPending ? (
          <LoadingState variant="skeleton" rows={4} label={t('loading')} />
        ) : items.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void items.refetch()} />
        ) : items.data.attentionItems.length === 0 ? (
          <EmptyState
            title={t(filter === 'open' ? 'emptyTitle' : 'emptySettledTitle')}
            description={t(filter === 'open' ? 'emptyDescription' : 'emptySettledDescription')}
          />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="attention-list">
            {items.data.attentionItems.map((item) => (
              <li key={item.id}>
                <AttentionCard item={item} />
              </li>
            ))}
          </ul>
        )}
        {items.data?.truncated === true ? (
          <p className="mt-2 text-xs text-muted-foreground">{t('truncated')}</p>
        ) : null}
      </section>
    </AppPage>
  );
}
