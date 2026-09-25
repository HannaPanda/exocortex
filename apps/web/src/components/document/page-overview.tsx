'use client';

import { ChevronRightIcon, RefreshCwIcon, SparklesIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentOverviewResponse, type OverviewEntry } from '@exocortex/contracts';
import { Badge, Button, cn } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocumentOverview, useRefreshDocumentOverview } from '@/lib/api/overview-queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/**
 * The overview of a page's sub-pages (issue #53, ADR-028).
 *
 * Everything here is derived and nothing is editable: the paragraph is composed
 * from the children's digests, the list is read from the tree. The page body
 * stays where it is, above this, and is never touched.
 *
 * Renders nothing at all for an ordinary page, so the caller can mount it
 * unconditionally.
 */
export function PageOverview({
  workspaceId,
  documentId,
  readOnly,
}: {
  workspaceId: string;
  documentId: string;
  readOnly: boolean;
}) {
  const t = useTranslations('document.overview');
  const overview = useDocumentOverview(documentId);
  const refresh = useRefreshDocumentOverview();
  const [pending, setPending] = React.useState(false);

  // The refresh request only queues the work, so the waiting state cannot end
  // with the mutation. It ends when the worker says it is over.
  useRealtimeEvent('document.overview.updated', (event) => {
    if (event.payload.documentId !== documentId) return;
    setPending(false);
    void overview.refetch();
  });

  if (overview.data === undefined || overview.data.mode === 'off') return null;
  const data = overview.data;

  const start = async (): Promise<void> => {
    setPending(true);
    const result = await refresh.mutateAsync(documentId).catch(() => null);
    // A refusal is answered on the spot and no event follows it.
    if (result === null || result.status === 'skipped') setPending(false);
  };

  return (
    <section
      className="mt-6 mb-8 flex flex-col gap-4 border-t border-border pt-6"
      data-testid="page-overview"
    >
      <OverviewIntro data={data} pending={pending} />
      {data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noChildren')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.entries.map((entry) => (
            <OverviewRow key={entry.documentId} workspaceId={workspaceId} entry={entry} />
          ))}
        </ul>
      )}
      <OverviewFooter data={data} pending={pending} readOnly={readOnly} onRefresh={start} />
    </section>
  );
}

/**
 * The composed paragraph, or the honest silence in its place.
 *
 * The three silences read differently on purpose: a page that has never been
 * composed is waiting, a deployment with no model is not going to compose one,
 * and a page whose last run failed says so. A list with no explanation at all
 * would look the same in all three cases.
 */
function OverviewIntro({ data, pending }: { data: DocumentOverviewResponse; pending: boolean }) {
  const t = useTranslations('document.overview');
  if (data.intro !== null) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm leading-relaxed text-foreground">{data.intro}</p>
      </div>
    );
  }
  if (pending) {
    return <p className="text-sm text-muted-foreground">{t('introWriting')}</p>;
  }
  // A code is worded here, in the reader's language (issue #98); a row older
  // than the codes still carries its stored sentence in `error`.
  if (data.errorDetail !== null) {
    return (
      <p className="text-sm text-muted-foreground">
        {data.errorDetail.code === 'too_many_children'
          ? t('errors.too_many_children', { maxChildren: data.errorDetail.maxChildren })
          : t(`errors.${data.errorDetail.code}`)}
      </p>
    );
  }
  if (data.error !== null) {
    return <p className="text-sm text-muted-foreground">{data.error}</p>;
  }
  return (
    <p className="text-sm text-muted-foreground">
      {data.state === 'unavailable' ? t('introUnavailable') : t('introNextRun')}
    </p>
  );
}

/** One child: icon, title, its own digest, and how much is underneath it. */
function OverviewRow({ workspaceId, entry }: { workspaceId: string; entry: OverviewEntry }) {
  const t = useTranslations('document.overview');
  return (
    <li>
      <Link
        href={`/arbeitsbereich/${workspaceId}/seite/${entry.documentId}`}
        className="group flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/60"
      >
        <DocumentIcon
          icon={entry.icon}
          iconColor={entry.iconColor}
          type={entry.type}
          className="mt-0.5 text-muted-foreground"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="text-sm font-medium break-words text-foreground">{entry.title}</span>
            {entry.childCount > 0 ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t('childCount', { count: entry.childCount })}
              </span>
            ) : null}
          </span>
          {entry.summary === null ? null : (
            <span className="text-sm leading-relaxed text-muted-foreground">{entry.summary}</span>
          )}
        </span>
        <ChevronRightIcon
          aria-hidden
          className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        />
      </Link>
    </li>
  );
}

/** Where the text comes from, how old it is, and the one button. */
function OverviewFooter({
  data,
  pending,
  readOnly,
  onRefresh,
}: {
  data: DocumentOverviewResponse;
  pending: boolean;
  readOnly: boolean;
  onRefresh: () => Promise<void>;
}) {
  const t = useTranslations('document.overview');
  const format = useFormatter();
  const moment = (iso: string): string => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? iso
      : format.dateTime(parsed, { dateStyle: 'medium', timeStyle: 'short' });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
      <SparklesIcon className="size-3.5" aria-hidden />
      <span>
        {data.generatedAt === null
          ? t('sourceAutomatic')
          : t('sourceGeneratedAt', { time: moment(data.generatedAt) })}
      </span>
      {data.stale ? (
        <Badge variant="outline" className="border-warning/50 text-warning">
          {t('stale')}
        </Badge>
      ) : null}
      {readOnly ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          disabled={pending}
          data-testid="overview-refresh"
          onClick={() => void onRefresh()}
        >
          <RefreshCwIcon className={cn('size-3.5', pending && 'animate-spin')} aria-hidden />
          {pending ? t('refreshing') : t('refresh')}
        </Button>
      )}
    </div>
  );
}
