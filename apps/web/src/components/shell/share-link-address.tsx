'use client';

import { CheckIcon, CopyIcon, LinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentShare } from '@exocortex/contracts';
import { Button } from '@exocortex/ui';

import { useCreateLinkFor } from '@/lib/api/share-queries';

/** The address a person opens, on the origin this page was served from. */
export function shareUrlFor(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/freigabe/${encodeURIComponent(token)}`;
}

/**
 * The whole address of a public link, where the reader may see it.
 *
 * Since the ADR-044 addendum of 2026-09-24 the API keeps a sealed copy of the
 * token and hands it to whoever may manage the workspace's shares, because a
 * link is made to be passed on and hiding it after creation only made people
 * mint a second one. A link from before that day has only its hash; its row
 * says so and offers the one thing that helps, a fresh link with the same
 * reach. The old one keeps working until somebody withdraws it, so replacing
 * is never a surprise for whoever already holds it.
 *
 * Renders nothing for a grant to an account, for a withdrawn link and for a
 * reader below ADMIN, who is shown the prefix in the row's sentence instead.
 */
export function ShareLinkAddress({
  share,
  testIdPrefix,
}: {
  share: DocumentShare;
  testIdPrefix: string;
}) {
  const t = useTranslations('shares.linkAddress');
  const [copied, setCopied] = React.useState(false);
  const replace = useCreateLinkFor();

  if (share.kind !== 'PUBLIC_LINK' || share.revokedAt !== null) return null;

  if (share.token !== null) {
    const url = shareUrlFor(share.token);
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid={`${testIdPrefix}-link-address`}>
        <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs select-all">
          {url}
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid={`${testIdPrefix}-link-copy`}
          aria-label={copied ? t('copiedLabel') : t('copyLabel')}
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? t('copied') : t('copy')}
        </Button>
      </div>
    );
  }

  if (share.tokenSealed) return null;

  return (
    <div
      className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center"
      data-testid={`${testIdPrefix}-link-lost`}
    >
      <p className="min-w-0 flex-1">{t('lost')}</p>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={replace.isPending || replace.isSuccess}
        data-testid={`${testIdPrefix}-link-replace`}
        onClick={() => replace.mutate({ documentId: share.documentId, scope: share.scope })}
      >
        <LinkIcon /> {replace.isSuccess ? t('replaced') : t('replace')}
      </Button>
    </div>
  );
}
