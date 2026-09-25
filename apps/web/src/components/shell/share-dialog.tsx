'use client';

import { CopyIcon, GlobeIcon, LinkIcon, MailIcon, TriangleAlertIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentShare, type ShareScope } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCreateShare,
  useDocumentShares,
  useRevokeShare,
  useUpdateShare,
} from '@/lib/api/share-queries';

import { ShareLinkAddress, shareUrlFor } from './share-link-address';
import { ShareRevokeConfirm } from './share-revoke-confirm';
import { describeShare } from './share-wording';

/**
 * Handing a page to somebody who is not in this workspace (issue #83, ADR-044).
 *
 * The copy in here does a job the controls cannot: everything on this dialog
 * reaches outside, and the two mistakes it has to prevent are believing a
 * public link is somehow private, and not noticing that a page is already
 * readable because a section above it was shared. So the inherited grants sit
 * at the top, before anything can be clicked, and the link section says in
 * plain words what an address on the internet means.
 */

const SCOPE_KEYS = {
  PAGE_ONLY: 'scopePageOnly',
  SUBTREE: 'scopeSubtree',
} as const satisfies Record<ShareScope, string>;

const EXPIRY_OPTIONS = ['never', '7', '30', '90'] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

function expiresInDays(value: ExpiryOption): number | null {
  return value === 'never' ? null : Number(value);
}

export function ShareDialog({
  documentId,
  documentTitle,
  open,
  onOpenChange,
}: {
  documentId: string;
  documentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shares.dialog');
  const tCommon = useTranslations('shares.common');
  const tWording = useTranslations('shares.wording');
  const format = useFormatter();
  const describe = (share: DocumentShare): string => describeShare(share, tWording, format);
  const expiryLabel = (value: ExpiryOption): string =>
    value === 'never' ? t('expiryNever') : t('expiryDays', { count: Number(value) });
  const shares = useDocumentShares(documentId, { enabled: open });
  const createShare = useCreateShare(documentId);
  const updateShare = useUpdateShare(documentId);
  const revokeShare = useRevokeShare(documentId);

  const [email, setEmail] = React.useState('');
  const [permission, setPermission] = React.useState<'READ' | 'WRITE'>('READ');
  const [scope, setScope] = React.useState<ShareScope>('PAGE_ONLY');
  const [expiry, setExpiry] = React.useState<ExpiryOption>('never');
  /** The address of the link just made, shown at the button that made it. */
  const [freshLink, setFreshLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  /** The share whose withdrawal is being confirmed, by id. At most one. */
  const [revoking, setRevoking] = React.useState<string | null>(null);

  /*
   * Closing the dialog clears the form and the confirmation. The new link's
   * address stays reachable in the list below for as long as the link lives
   * (ADR-044 addendum), so nothing is lost by forgetting it here.
   */
  const close = (next: boolean): void => {
    if (!next) {
      setFreshLink(null);
      setCopied(false);
      setEmail('');
      setRevoking(null);
      revokeShare.reset();
    }
    onOpenChange(next);
  };

  // Only the creating half. A refused withdrawal belongs beside the row it was
  // asked about, not in a banner at the top of a dialog the reader has scrolled
  // past: it is the answer to a question they asked three lines above.
  const errorCode = createShare.error instanceof ApiError ? createShare.error.code : undefined;

  const active = (shares.data?.shares ?? []).filter((share) => share.revokedAt === null);
  const inherited = shares.data?.inherited ?? [];

  function handleInvite(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    createShare.mutate(
      {
        kind: 'USER',
        email: trimmed,
        permission,
        scope,
        expiresInDays: expiresInDays(expiry),
      },
      { onSuccess: () => setEmail('') },
    );
  }

  function handleCreateLink(): void {
    createShare.mutate(
      { kind: 'PUBLIC_LINK', permission: 'READ', scope, expiresInDays: expiresInDays(expiry) },
      {
        onSuccess: (response) => {
          if (response.share.token !== null) setFreshLink(shareUrlFor(response.share.token));
          setCopied(false);
        },
      },
    );
  }

  async function handleCopy(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{t('title', { title: documentTitle })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {inherited.length > 0 ? (
          <Alert data-testid="share-inherited">
            <TriangleAlertIcon />
            <AlertDescription>
              {t('inherited')}
              <ul className="mt-2 list-disc pl-4">
                {inherited.map((share) => (
                  <li key={share.id}>{describe(share)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {errorCode === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="share-scope">{t('scope')}</Label>
          <div className="flex flex-wrap gap-2">
            <Select value={scope} onValueChange={(next) => setScope(next as ShareScope)}>
              <SelectTrigger id="share-scope" className="w-64">
                <SelectValue>{() => t(SCOPE_KEYS[scope])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PAGE_ONLY">{t(SCOPE_KEYS.PAGE_ONLY)}</SelectItem>
                <SelectItem value="SUBTREE">{t(SCOPE_KEYS.SUBTREE)}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={expiry} onValueChange={(next) => setExpiry(next as ExpiryOption)}>
              <SelectTrigger aria-label={t('expiry')} className="w-40">
                <SelectValue>{() => expiryLabel(expiry)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {expiryLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <form className="flex flex-wrap items-end gap-2" onSubmit={handleInvite}>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="share-email">{t('toAccount')}</Label>
            <Input
              id="share-email"
              type="email"
              value={email}
              placeholder={t('emailPlaceholder')}
              data-testid="share-email"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Select
            value={permission}
            onValueChange={(next) => setPermission(next as 'READ' | 'WRITE')}
          >
            <SelectTrigger aria-label={t('permission')} className="w-40">
              <SelectValue>
                {() => (permission === 'WRITE' ? tCommon('write') : tCommon('read'))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="READ">{tCommon('read')}</SelectItem>
              <SelectItem value="WRITE">{tCommon('write')}</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={email.trim().length === 0 || createShare.isPending}>
            <MailIcon /> {t('share')}
          </Button>
        </form>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t('publicLink')}</p>
              <p className="text-xs text-muted-foreground">{t('publicLinkExplanation')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="share-create-link"
              disabled={createShare.isPending}
              onClick={handleCreateLink}
            >
              <LinkIcon /> {t('createLink')}
            </Button>
          </div>
          {freshLink === null ? null : (
            <div className="flex flex-col gap-1.5" data-testid="share-fresh-link">
              <div className="rounded-md border border-border bg-muted p-2 font-mono text-xs select-all break-all">
                {freshLink}
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleCopy(freshLink)}>
                <CopyIcon /> {copied ? t('copied') : t('copyAddress')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('addressKept')}</p>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t('current')}</h3>
          {shares.isPending ? (
            <LoadingState label={tCommon('loading')} variant="skeleton" rows={2} />
          ) : shares.isError ? (
            <ErrorState title={tCommon('loadError')} onRetry={() => void shares.refetch()} />
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('nobody')}</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="share-list">
              {active.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  description={describe(share)}
                  confirming={revoking === share.id}
                  onAskRevoke={() => {
                    revokeShare.reset();
                    setRevoking(share.id);
                  }}
                  onCancelRevoke={() => setRevoking(null)}
                  onConfirmRevoke={() =>
                    revokeShare.mutate(share.id, { onSuccess: () => setRevoking(null) })
                  }
                  onPermissionChange={(permission) =>
                    updateShare.mutate({ shareId: share.id, request: { permission } })
                  }
                  revokePending={revokeShare.isPending}
                  revokeError={
                    revokeShare.isError
                      ? revokeShare.error instanceof ApiError
                        ? messageForCode(revokeShare.error.code)
                        : t('revokeFailed')
                      : null
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One active grant, and the question that has to be answered before it goes.
 *
 * The confirmation is inline rather than a second dialog on top of this one.
 * DESIGN.md rules out reaching for a modal before the inline alternatives are
 * exhausted, and here the inline one is also the better answer: the sentence
 * belongs beside the grant it is about, the row stays on screen while it is
 * read, and on a phone a dialog inside a dialog has nowhere to go. What is
 * borrowed from the trash confirmation is the part that matters -- name what
 * goes, name what cannot be undone, and put the safe choice first.
 */
function ShareRow({
  share,
  description,
  confirming,
  onAskRevoke,
  onCancelRevoke,
  onConfirmRevoke,
  onPermissionChange,
  revokePending,
  revokeError,
}: {
  share: DocumentShare;
  description: string;
  confirming: boolean;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
  onPermissionChange: (permission: 'READ' | 'WRITE') => void;
  revokePending: boolean;
  revokeError: string | null;
}) {
  const t = useTranslations('shares.dialog');
  const tCommon = useTranslations('shares.common');
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border px-3 py-2"
      data-testid="share-row"
    >
      <div className="flex flex-wrap items-center gap-2">
        {share.kind === 'PUBLIC_LINK' ? <GlobeIcon className="size-4" /> : null}
        <span className="min-w-0 flex-1 truncate text-sm">{description}</span>
        {confirming ? null : (
          <>
            {share.kind === 'USER' ? (
              <Select
                value={share.permission}
                onValueChange={(next) => onPermissionChange(next as 'READ' | 'WRITE')}
              >
                <SelectTrigger aria-label={t('changePermission')} className="w-32">
                  <SelectValue>
                    {() => (share.permission === 'WRITE' ? tCommon('write') : tCommon('read'))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="READ">{tCommon('read')}</SelectItem>
                  <SelectItem value="WRITE">{tCommon('write')}</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="muted">{t('readOnly')}</Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              data-testid="share-revoke"
              // The word repeats once per row, so the row's own sentence is
              // what tells a screen reader which grant this button is for.
              aria-label={t('revokeLabel', { description })}
              onClick={onAskRevoke}
            >
              {tCommon('revoke')}
            </Button>
          </>
        )}
      </div>

      {confirming ? null : <ShareLinkAddress share={share} testIdPrefix="share" />}

      {confirming ? (
        <ShareRevokeConfirm
          share={share}
          where="dialog"
          testIdPrefix="share"
          pending={revokePending}
          error={revokeError}
          onCancel={onCancelRevoke}
          onConfirm={onConfirmRevoke}
        />
      ) : null}
    </li>
  );
}
