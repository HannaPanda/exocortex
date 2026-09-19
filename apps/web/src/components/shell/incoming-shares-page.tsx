'use client';

import Link from 'next/link';

import { AppPage, Badge, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useIncomingShares } from '@/lib/api/share-queries';

/**
 * Pages other people have shared with this account (issue #83, ADR-044).
 *
 * The only list in the application that crosses workspace boundaries, and the
 * only way to these pages at all: the reader is not a member of the workspace
 * the page lives in, so no navigation tree will ever show it to them. Without
 * this page a share would be a link somebody has to have kept.
 */
export function IncomingSharesPage() {
  const shares = useIncomingShares();

  if (shares.isPending) return <LoadingState label="Freigaben werden geladen …" />;
  if (shares.isError) {
    return (
      <ErrorState
        title="Freigaben konnten nicht geladen werden"
        onRetry={() => void shares.refetch()}
      />
    );
  }

  return (
    <AppPage maxWidth="max-w-3xl">
      <h1 className="text-lg font-semibold">Mit mir geteilt</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Seiten aus Arbeitsbereichen, in denen du kein Mitglied bist. Sie stehen in keiner
        Navigation, nur hier.
      </p>

      {shares.data.shares.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Noch nichts geteilt"
          description="Wenn jemand dir eine Seite freigibt, taucht sie hier auf."
        />
      ) : (
        <ul className="mt-8 flex flex-col gap-2" data-testid="incoming-shares">
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
                    aus „{share.workspaceName}“, von {share.sharedByName}
                  </span>
                </span>
                <Badge variant="muted">
                  {share.permission === 'WRITE' ? 'Bearbeiten' : 'Lesen'}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppPage>
  );
}
