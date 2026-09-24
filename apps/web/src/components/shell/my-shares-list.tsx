'use client';

import { GlobeIcon, UserIcon } from 'lucide-react';
import Link from 'next/link';
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

import { describeShare, revokeConsequence } from './share-wording';

type ShareState = 'active' | 'expired' | 'revoked';

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
  const shares = useMyShares();
  const revoke = useRevokeMyShare();
  const [showInactive, setShowInactive] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  /** The share whose withdrawal is being confirmed, by id. At most one. */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  if (shares.isPending) return <LoadingState label="Freigaben werden geladen …" />;
  if (shares.isError) {
    return (
      <ErrorState
        title="Freigaben konnten nicht geladen werden"
        onRetry={() => void shares.refetch()}
      />
    );
  }

  // Expiry is judged against the moment the answer arrived, not the render:
  // the list refetches on focus, so this is never far behind the clock.
  const now = shares.dataUpdatedAt;
  const all = shares.data.shares;
  const inactiveCount = all.filter((share) => stateOf(share, now) !== 'active').length;
  const needle = filter.trim().toLocaleLowerCase('de-DE');
  const rows = all
    .filter((share) => showInactive || stateOf(share, now) === 'active')
    .filter(
      (share) =>
        needle.length === 0 ||
        `${share.documentTitle} ${share.workspaceName} ${share.grantee?.email ?? ''}`
          .toLocaleLowerCase('de-DE')
          .includes(needle),
    );

  return (
    <>
      <p className="max-w-measure text-sm text-muted-foreground">
        Alles, was du selbst freigegeben hast, aus allen Arbeitsbereichen: an einzelne Konten und
        als öffentlicher Link.
      </p>

      {all.length === 0 ? (
        <EmptyState
          className="mt-6"
          title="Nichts freigegeben"
          description="Du hast noch keine Seite geteilt. Das geht im Seitenmenü über „Teilen …“."
        />
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {all.length >= FILTER_THRESHOLD ? (
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Seite, Arbeitsbereich oder Adresse …"
                aria-label="Freigaben filtern"
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
                Beendete zeigen ({inactiveCount})
              </Label>
            ) : null}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              className="mt-6"
              title={needle.length > 0 ? 'Nichts gefunden' : 'Nichts mehr offen'}
              description={
                needle.length > 0
                  ? 'Keine Freigabe passt zu diesem Filter.'
                  : 'Alle deine Freigaben sind zurückgezogen oder abgelaufen.'
              }
            />
          ) : (
            <ul className="mt-4 flex flex-col gap-2" data-testid="my-shares">
              {rows.map((share) => (
                <MyShareRow
                  key={share.id}
                  share={share}
                  state={stateOf(share, now)}
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
                        : 'Die Freigabe konnte nicht zurückgezogen werden.'
                      : null
                  }
                />
              ))}
            </ul>
          )}

          {shares.data.truncated ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Es gibt mehr Freigaben, als hier stehen. Die ältesten beendeten fehlen.
            </p>
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
            in „{share.workspaceName}“ · {describeShare(share)}
          </span>
        </span>
        {state === 'active' ? null : (
          <Badge variant="muted">{state === 'revoked' ? 'Zurückgezogen' : 'Abgelaufen'}</Badge>
        )}
        {state === 'revoked' || confirming ? null : share.canRevoke ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="my-share-revoke"
            aria-label={`Zurückziehen: ${share.documentTitle}, ${describeShare(share)}`}
            onClick={onAskRevoke}
          >
            Zurückziehen
          </Button>
        ) : null}
      </div>

      {!share.canRevoke && state !== 'revoked' ? (
        <p className="text-xs text-muted-foreground">
          Zurückziehen kann hier nur, wer im Arbeitsbereich „{share.workspaceName}“ Admin ist.
        </p>
      ) : null}

      {confirming ? (
        <div
          className="flex flex-col gap-2 border-t border-border pt-2"
          data-testid="my-share-revoke-confirm"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            onCancelRevoke();
          }}
        >
          <p role="alert" className="text-sm">
            <span className="font-medium">Zurückziehen?</span>{' '}
            <span className="text-muted-foreground">{revokeConsequence(share, 'list')}</span>
          </p>
          {revokeError === null ? null : (
            <p role="alert" className="text-xs text-destructive-text">
              {revokeError}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              autoFocus
              data-testid="my-share-revoke-cancel"
              onClick={onCancelRevoke}
            >
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={revokePending}
              data-testid="my-share-revoke-confirm-button"
              onClick={onConfirmRevoke}
            >
              {revokePending ? 'Wird zurückgezogen …' : 'Zurückziehen'}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function stateOf(share: MyShare, now: number): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  if (share.expiresAt !== null && new Date(share.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}
