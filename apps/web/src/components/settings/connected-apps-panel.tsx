'use client';

import { PlugZapIcon } from 'lucide-react';
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

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

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

  const [target, setTarget] = React.useState<ConnectedApp | null>(null);
  const disconnectErrorCode =
    disconnect.error instanceof ApiError ? disconnect.error.code : undefined;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="connected-apps-heading">
      <div>
        <h2 id="connected-apps-heading" className="text-sm font-semibold">
          Verbundene Anwendungen
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Programme, denen du auf der Zustimmungsseite Zugriff gegeben hast, zum Beispiel ChatGPT.
          Sie melden sich in deinem Namen an, ohne ein Token von dir. Trennen wirkt sofort: laufende
          Sitzungen enden, und ein erneuter Zugriff braucht deine Zustimmung von vorn.
        </p>
      </div>

      {disconnect.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{messageForCode(disconnectErrorCode)}</AlertDescription>
        </Alert>
      ) : null}

      {appsQuery.isPending ? (
        <LoadingState label="Verbindungen werden geladen …" variant="skeleton" rows={2} />
      ) : appsQuery.isError ? (
        <ErrorState
          title="Verbindungen konnten nicht geladen werden"
          onRetry={() => void appsQuery.refetch()}
        />
      ) : appsQuery.data.length === 0 ? (
        <EmptyState
          icon={PlugZapIcon}
          title="Keine verbundenen Anwendungen"
          description="Sobald du einen Connector wie ChatGPT verbindest, steht er hier und kann hier auch wieder getrennt werden."
          className="rounded-lg border border-dashed border-border"
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">Liste der verbundenen Anwendungen</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Anwendung</TableHead>
              <TableHead>Verbunden seit</TableHead>
              <TableHead>Zuletzt angemeldet</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {appsQuery.data.map((app) => {
              const host = hostOf(app);
              return (
                <TableRow key={app.clientId}>
                  <TableCell>
                    <span className="font-medium">{app.name}</span>
                    {host !== null ? (
                      <span className="block text-xs text-muted-foreground">{host}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>{dateTimeFormat.format(new Date(app.connectedAt))}</TableCell>
                  <TableCell>
                    {app.lastAuthorizedAt !== null
                      ? dateTimeFormat.format(new Date(app.lastAuthorizedAt))
                      : '–'}
                  </TableCell>
                  <TableCell>
                    {app.disabled ? (
                      <Badge variant="muted">Abgeschaltet</Badge>
                    ) : app.activeTokenCount > 0 ? (
                      <Badge variant="default">Aktiv</Badge>
                    ) : (
                      // No live token, but the client can fetch a new one with
                      // its refresh token, so this is "idle", not "harmless".
                      <Badge variant="muted">Ruht</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disconnect.isPending}
                      onClick={() => setTarget(app)}
                    >
                      Trennen
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
            <DialogTitle>Verbindung trennen?</DialogTitle>
            <DialogDescription>
              {target !== null
                ? `„${target.name}“ verliert sofort den Zugriff. Bestehende Anmeldungen enden, und die Anwendung kann sich nicht mehr selbst erneuern. Um sie wieder zu verbinden, musst du sie in ihrem eigenen Programm erneut hinzufügen und deine Zustimmung erneut geben.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => {
                if (target === null) return;
                disconnect.mutate(target.clientId, { onSuccess: () => setTarget(null) });
              }}
            >
              Trennen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
