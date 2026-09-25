'use client';

import { GlobeIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentShare } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useRevokeWorkspaceShare, useWorkspaceShares } from '@/lib/api/share-queries';

import { ShareLinkAddress } from './share-link-address';
import { ShareRevokeConfirm } from './share-revoke-confirm';
import { shareStateOf } from './share-wording';

/**
 * Everything this workspace has handed out (issue #83, ADR-044).
 *
 * The page that makes the feature reviewable. A share is made in a dialog on
 * one page and then forgotten about; without one list of all of them, "what is
 * public here" is a question nobody can answer, and the honest answer after a
 * year would be "we do not know".
 *
 * Withdrawn grants stay in the list rather than disappearing, because "this was
 * public until March" is part of the answer too.
 */
export function WorkspaceSharesPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('shares.workspace');
  const tCommon = useTranslations('shares.common');
  const tState = useTranslations('shares.state');
  const format = useFormatter();
  const shares = useWorkspaceShares(workspaceId);
  const revoke = useRevokeWorkspaceShare(workspaceId);
  /** The share whose withdrawal is being confirmed, by id. At most one. */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  if (shares.isPending) return <LoadingState label={tCommon('loading')} />;
  if (shares.isError) {
    return <ErrorState title={tCommon('loadError')} onRetry={() => void shares.refetch()} />;
  }

  const rows = shares.data.shares;
  // Expiry is judged against the moment the answer arrived, not the render.
  const now = shares.dataUpdatedAt;

  return (
    <AppPage maxWidth="max-w-5xl">
      <h1 className="exocortex-page-title">{t('title')}</h1>
      <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-8"
          title={tCommon('nothingShared')}
          description={t('emptyDescription')}
        />
      ) : (
        <Table narrow="list" className="mt-8" data-testid="workspace-shares">
          <TableHeader>
            <TableRow>
              <TableHead>{t('columnPage')}</TableHead>
              <TableHead>{t('columnRecipient')}</TableHead>
              <TableHead>{t('columnPermission')}</TableHead>
              <TableHead>{t('columnScope')}</TableHead>
              <TableHead>{t('columnExpires')}</TableHead>
              <TableHead>{t('columnStatus')}</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((share) => (
              <React.Fragment key={share.id}>
                <TableRow data-testid="workspace-share-row" data-state={shareStateOf(share, now)}>
                  <TableCell cell="title">
                    <Link
                      href={`/arbeitsbereich/${workspaceId}/seite/${share.documentId}`}
                      className="font-medium hover:underline"
                    >
                      {share.documentTitle}
                    </Link>
                  </TableCell>
                  <TableCell
                    label={t('columnRecipient')}
                    className="max-w-72 text-sm whitespace-normal"
                  >
                    <div className="flex flex-col gap-1.5">
                      {recipientOf(share, t)}
                      <ShareLinkAddress share={share} testIdPrefix="workspace-share" />
                    </div>
                  </TableCell>
                  <TableCell label={t('columnPermission')}>
                    <Badge variant="muted">
                      {share.permission === 'WRITE' ? tCommon('write') : tCommon('read')}
                    </Badge>
                  </TableCell>
                  <TableCell label={t('columnScope')} className="text-sm text-muted-foreground">
                    {share.scope === 'SUBTREE' ? t('scopeSubtree') : t('scopePageOnly')}
                  </TableCell>
                  <TableCell label={t('columnExpires')} className="text-sm text-muted-foreground">
                    {share.expiresAt === null
                      ? '–'
                      : format.dateTime(new Date(share.expiresAt), { dateStyle: 'medium' })}
                  </TableCell>
                  <TableCell label={t('columnStatus')}>
                    <Badge variant={shareStateOf(share, now) === 'active' ? 'default' : 'muted'}>
                      {tState(shareStateOf(share, now))}
                    </Badge>
                  </TableCell>
                  <TableCell cell="actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={share.revokedAt !== null || confirming === share.id}
                      data-testid="workspace-share-revoke"
                      aria-label={t('revokeLabel', { title: share.documentTitle })}
                      onClick={() => {
                        revoke.reset();
                        setConfirming(share.id);
                      }}
                    >
                      {tCommon('revoke')}
                    </Button>
                  </TableCell>
                </TableRow>
                {confirming === share.id ? (
                  <TableRow>
                    <TableCell colSpan={7} className="whitespace-normal">
                      <ShareRevokeConfirm
                        share={share}
                        where="list"
                        testIdPrefix="workspace-share"
                        pending={revoke.isPending}
                        error={
                          revoke.isError
                            ? revoke.error instanceof ApiError
                              ? messageForCode(revoke.error.code)
                              : tCommon('revokeFailed')
                            : null
                        }
                        onCancel={() => setConfirming(null)}
                        onConfirm={() =>
                          revoke.mutate(share.id, { onSuccess: () => setConfirming(null) })
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      )}
    </AppPage>
  );
}

function recipientOf(
  share: DocumentShare,
  t: ReturnType<typeof useTranslations<'shares.workspace'>>,
): React.ReactNode {
  if (share.kind === 'PUBLIC_LINK') {
    return (
      <span className="flex items-center gap-1.5">
        <GlobeIcon className="size-3.5" /> {t('publicLink')}
        <span className="font-mono text-xs text-muted-foreground">…{share.tokenPrefix ?? ''}</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <UserIcon className="size-3.5" /> {share.grantee?.email ?? t('unknown')}
    </span>
  );
}
