'use client';

import * as React from 'react';

import { type NotificationPreference } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Switch,
} from '@exocortex/ui';

import {
  useNotificationPreferences,
  useSetNotificationPreference,
} from '@/lib/api/notification-queries';

/**
 * Was dieses Konto per Mail hören will (Issue #105, ADR-052).
 *
 * Bewusst neben den Geräten und nicht zwischen ihnen: eine Adresse gehört zur
 * Person, ein Push-Abonnement zu einem Browser. Die Überschrift sagt den
 * Unterschied, weil er sonst wie eine Doppelung aussieht.
 *
 * Angeboten wird nur, was diese Installation auch zustellt. Die möglichen
 * Zustellarten kommen je Zeile aus der Antwort, nicht aus einer Liste hier:
 * eine Oberfläche, die eine vierte Art anbietet, die der Server ablehnt, wäre
 * ein Schalter, der nichts tut.
 */
export function NotificationPreferencesPanel() {
  const query = useNotificationPreferences();
  const set = useSetNotificationPreference();
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (preference: NotificationPreference, enabled: boolean) => {
    setError(null);
    set.mutate(
      {
        kind: preference.kind,
        channel: preference.channel,
        mode: enabled ? 'IMMEDIATE' : 'OFF',
      },
      {
        onError: (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Das hat nicht geklappt.');
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="notification-preferences-heading">
      <div>
        <h2 id="notification-preferences-heading" className="text-sm font-semibold">
          Per E-Mail
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Mail geht an dein Konto und nicht an ein Gerät, deshalb gilt das hier überall gleich.
          Gedacht für das, was auch morgen noch wichtig ist und was dich erreichen soll, wenn du
          gerade gar nicht in eXocortex bist.
        </p>
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <LoadingState label="Einstellungen werden geladen …" variant="skeleton" rows={1} />
      ) : query.isError ? (
        <ErrorState
          title="Einstellungen konnten nicht geladen werden"
          onRetry={() => void query.refetch()}
        />
      ) : query.data.preferences.length === 0 ? (
        <EmptyState
          title="Nichts einzustellen"
          description="Diese Installation verschickt derzeit keine Mail, über die du selbst entscheiden kannst."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.preferences.map((preference) => {
            const id = `${preference.kind}-${preference.channel}`;
            return (
              <li key={id} className="flex items-start gap-3 rounded-md border border-border p-3">
                <Switch
                  id={id}
                  checked={preference.mode !== 'OFF'}
                  disabled={set.isPending}
                  onCheckedChange={(checked: boolean) => toggle(preference, checked)}
                />
                <div>
                  <Label htmlFor={id} className="text-sm">
                    {preference.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">{preference.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
