'use client';

import { PlugZapIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type ConnectedApp } from '@exocortex/contracts';
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
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useConnectedApps, useDisconnectApp } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** The host of the first redirect URL, which is the one recognisable part of a claimed identity. */
function hostOf(app: ConnectedApp): string | null {
  const first = app.redirectUrls[0];
  if (first === undefined) return null;
  try {
    return new URL(first).host;
  } catch {
    return first;
  }
}

/**
 * The OAuth clients connected to this account: ChatGPT and anything else that
 * was let in through `/verbinden`.
 *
 * This is the only place in the product where such a connection can be taken
 * back, so the table shows what a person needs to decide with: what the client
 * called itself, where it sends people, since when it is connected, and whether
 * it can act right now.
 */
export function ConnectedAppsPanel() {
  const appsQuery = useConnectedApps();
  const disconnect = useDisconnectApp();
  const t = useTranslations('account.connectedApps');
  const format = useFormatter();

  const [target, setTarget] = React.useState<ConnectedApp | null>(null);
  const disconnectErrorCode =
    disconnect.error instanceof ApiError ? disconnect.error.code : undefined;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="connected-apps-heading">
      <div>
        <h2 id="connected-apps-heading" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {disconnect.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{messageForCode(disconnectErrorCode)}</AlertDescription>
        </Alert>
      ) : null}

      {appsQuery.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={2} />
      ) : appsQuery.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void appsQuery.refetch()} />
      ) : appsQuery.data.length === 0 ? (
        <EmptyState
          icon={PlugZapIcon}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          className="rounded-lg border border-dashed border-border"
        />
      ) : (
        <Table narrow="list">
          <TableCaption className="sr-only">{t('caption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columnApp')}</TableHead>
              <TableHead>{t('columnConnectedAt')}</TableHead>
              <TableHead>{t('columnLastAuthorized')}</TableHead>
              <TableHead>{t('columnStatus')}</TableHead>
              <TableHead className="text-right">{t('columnActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {appsQuery.data.map((app) => {
              const host = hostOf(app);
              return (
                <TableRow key={app.clientId}>
                  <TableCell cell="title">
                    <span className="font-medium">{app.name}</span>
                    {host !== null ? (
                      <span className="block text-xs text-muted-foreground">{host}</span>
                    ) : null}
                  </TableCell>
                  <TableCell label={t('columnConnectedAt')}>
                    {format.dateTime(new Date(app.connectedAt), DATE_TIME)}
                  </TableCell>
                  <TableCell label={t('columnLastAuthorized')}>
                    {app.lastAuthorizedAt !== null
                      ? format.dateTime(new Date(app.lastAuthorizedAt), DATE_TIME)
                      : t('never')}
                  </TableCell>
                  <TableCell label={t('columnStatus')}>
                    {app.disabled ? (
                      <Badge variant="muted">{t('statusDisabled')}</Badge>
                    ) : app.activeGrantCount > 0 ? (
                      // The client can still fetch itself a new access token.
                      // Whether it is holding one right now is not knowable:
                      // an access token is a signed JWT nobody keeps a copy of.
                      <Badge variant="default">{t('statusActive')}</Badge>
                    ) : (
                      <Badge variant="muted">{t('statusIdle')}</Badge>
                    )}
                  </TableCell>
                  <TableCell cell="actions" className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disconnect.isPending}
                      onClick={() => setTarget(app)}
                    >
                      {t('disconnect')}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('disconnectTitle')}</DialogTitle>
            <DialogDescription>
              {target !== null ? t('disconnectDescription', { name: target.name }) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => {
                if (target === null) return;
                disconnect.mutate(target.clientId, { onSuccess: () => setTarget(null) });
              }}
            >
              {t('disconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
