'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useIncomingShares } from '@/lib/api/share-queries';

/**
 * Pages other people have shared with this account (issue #83, ADR-044).
 *
 * One of the two lists in the application that cross workspace boundaries,
 * and the only way to these pages at all: the reader is not a member of the
 * workspace the page lives in, so no navigation tree will ever show it to
 * them. Without this list a share would be a link somebody has to have kept.
 */
export function IncomingSharesList() {
  const t = useTranslations('shares.incoming');
  const tCommon = useTranslations('shares.common');
  const shares = useIncomingShares();

  if (shares.isPending) return <LoadingState label={tCommon('loading')} />;
  if (shares.isError) {
    return <ErrorState title={tCommon('loadError')} onRetry={() => void shares.refetch()} />;
  }

  return (
    <>
      <p className="max-w-measure text-sm text-muted-foreground">{t('intro')}</p>

      {shares.data.shares.length === 0 ? (
        <EmptyState className="mt-6" title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <ul className="mt-6 flex flex-col gap-2" data-testid="incoming-shares">
          {shares.data.shares.map((share) => (
            <li key={share.id} data-testid="incoming-share">
              <Link
                href={`/geteilt/${share.document.id}`}
                className="flex items-center gap-3 rounded-lg border border-border px-4 py-3 hover:bg-accent"
              >
                <DocumentIcon
                  icon={share.document.icon}
                  iconColor={share.document.iconColor}
                  type={share.document.type}
                  className="size-4"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{share.document.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {t('origin', { workspace: share.workspaceName, name: share.sharedByName })}
                  </span>
                </span>
                <Badge variant="muted">
                  {share.permission === 'WRITE' ? tCommon('write') : tCommon('read')}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
