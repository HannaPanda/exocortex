'use client';

import { GlobeIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import { type MyShare } from '@exocortex/contracts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Switch,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useMyShares, useRevokeMyShare } from '@/lib/api/share-queries';

import { ShareLinkAddress } from './share-link-address';
import { ShareRevokeConfirm } from './share-revoke-confirm';
import { describeShare, type ShareState, shareStateOf } from './share-wording';

/** Above this many rows a filter earns its place; below it, it is one more field. */
const FILTER_THRESHOLD = 6;

/**
 * Everything this account has handed out, in every workspace.
 *
 * The answer to "I shared a page and forgot which one": without it the only
 * way back to a forgotten public link was the share dialog of every page, one
 * at a time. The per-workspace overview answers a different question (what did
 * anybody share here) and is only as good as a person's memory of where.
 *
 * Live grants are the default because withdrawing one is what somebody comes
 * here to do; withdrawn and expired ones are one switch away, since "this was
 * public until March" is part of the answer too.
 */
export function MySharesList() {
  const t = useTranslations('shares.mine');
  const tCommon = useTranslations('shares.common');
  const locale = useLocale();
  const shares = useMyShares();
  const revoke = useRevokeMyShare();
  const [showInactive, setShowInactive] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  /** The share whose withdrawal is being confirmed, by id. At most one. */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  if (shares.isPending) return <LoadingState label={tCommon('loading')} />;
  if (shares.isError) {
    return <ErrorState title={tCommon('loadError')} onRetry={() => void shares.refetch()} />;
  }

  // Expiry is judged against the moment the answer arrived, not the render:
  // the list refetches on focus, so this is never far behind the clock.
  const now = shares.dataUpdatedAt;
  const all = shares.data.shares;
  const inactiveCount = all.filter((share) => shareStateOf(share, now) !== 'active').length;
  const needle = filter.trim().toLocaleLowerCase(locale);
  const rows = all
    .filter((share) => showInactive || shareStateOf(share, now) === 'active')
    .filter(
      (share) =>
        needle.length === 0 ||
        `${share.documentTitle} ${share.workspaceName} ${share.grantee?.email ?? ''}`
          .toLocaleLowerCase(locale)
          .includes(needle),
    );

  return (
    <>
      <p className="max-w-measure text-sm text-muted-foreground">{t('intro')}</p>

      {all.length === 0 ? (
        <EmptyState
          className="mt-6"
          title={tCommon('nothingShared')}
          description={t('emptyDescription')}
        />
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {all.length >= FILTER_THRESHOLD ? (
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t('filterPlaceholder')}
                aria-label={t('filterLabel')}
                className="sm:max-w-xs"
                data-testid="my-shares-filter"
              />
            ) : (
              <span />
            )}
            {inactiveCount > 0 ? (
              <Label className="flex items-center gap-2 font-normal">
                <Switch
                  checked={showInactive}
                  onCheckedChange={(checked) => setShowInactive(checked)}
                  data-testid="my-shares-show-inactive"
                />
                {t('showInactive', { count: inactiveCount })}
              </Label>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              className="mt-6"
              title={needle.length > 0 ? t('noMatchTitle') : t('noneOpenTitle')}
              description={needle.length > 0 ? t('noMatchDescription') : t('noneOpenDescription')}
            />
          ) : (
            <ul className="mt-4 flex flex-col gap-2" data-testid="my-shares">
              {rows.map((share) => (
                <MyShareRow
                  key={share.id}
                  share={share}
                  state={shareStateOf(share, now)}
                  confirming={confirming === share.id}
                  onAskRevoke={() => {
                    revoke.reset();
                    setConfirming(share.id);
                  }}
                  onCancelRevoke={() => setConfirming(null)}
                  onConfirmRevoke={() =>
                    revoke.mutate(share.id, { onSuccess: () => setConfirming(null) })
                  }
                  revokePending={revoke.isPending}
                  revokeError={
                    confirming === share.id && revoke.isError
                      ? revoke.error instanceof ApiError
                        ? messageForCode(revoke.error.code)
                        : tCommon('revokeFailed')
                      : null
                  }
                />
              ))}
            </ul>
          )}

          {shares.data.truncated ? (
            <p className="mt-4 text-xs text-muted-foreground">{t('truncated')}</p>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * One grant, with the same inline question the share dialog asks before it
 * withdraws anything: name what goes, name what cannot be undone, and put the
 * safe choice first.
 */
function MyShareRow({
  share,
  state,
  confirming,
  onAskRevoke,
  onCancelRevoke,
  onConfirmRevoke,
  revokePending,
  revokeError,
}: {
  share: MyShare;
  state: ShareState;
  confirming: boolean;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
  revokePending: boolean;
  revokeError: string | null;
}) {
  const t = useTranslations('shares.mine');
  const tCommon = useTranslations('shares.common');
  const tState = useTranslations('shares.state');
  const tWording = useTranslations('shares.wording');
  const format = useFormatter();
  const description = describeShare(share, tWording, format);
  const Icon = share.kind === 'PUBLIC_LINK' ? GlobeIcon : UserIcon;
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
      data-testid="my-share"
      data-state={state}
    >
      <div className="flex items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <Link
            href={`/arbeitsbereich/${share.workspaceId}/seite/${share.documentId}`}
            className="block truncate font-medium hover:underline"
          >
            {share.documentTitle}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">
            {t('rowContext', { workspace: share.workspaceName, description })}
          </span>
        </span>
        {state === 'active' ? null : <Badge variant="muted">{tState(state)}</Badge>}
        {state === 'revoked' || confirming ? null : share.canRevoke ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="my-share-revoke"
            aria-label={t('revokeLabel', { title: share.documentTitle, description })}
            onClick={onAskRevoke}
          >
            {tCommon('revoke')}
          </Button>
        ) : null}
      </div>

      {confirming ? null : <ShareLinkAddress share={share} testIdPrefix="my-share" />}

      {!share.canRevoke && state !== 'revoked' ? (
        <p className="text-xs text-muted-foreground">
          {t('adminOnly', { workspace: share.workspaceName })}
        </p>
      ) : null}

      {confirming ? (
        <ShareRevokeConfirm
          share={share}
          where="list"
          testIdPrefix="my-share"
          pending={revokePending}
          error={revokeError}
          onCancel={onCancelRevoke}
          onConfirm={onConfirmRevoke}
        />
      ) : null}
    </li>
  );
}
