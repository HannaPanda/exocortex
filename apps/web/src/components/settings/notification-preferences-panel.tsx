'use client';

import * as React from 'react';

import { type NotificationDeliveryMode, type NotificationPreference } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@exocortex/ui';

import {
  useNotificationPreferences,
  useSetNotificationPreference,
} from '@/lib/api/notification-queries';

/**
 * Was dieses Konto per Mail hören will (Issue #105, ADR-052; Issue #106).
 *
 * Bewusst neben den Geräten und nicht zwischen ihnen: eine Adresse gehört zur
 * Person, ein Push-Abonnement zu einem Browser. Die Überschrift sagt den
 * Unterschied, weil er sonst wie eine Doppelung aussieht.
 *
 * Angeboten wird nur, was diese Installation auch zustellt. Die möglichen
 * Zustellarten kommen je Zeile aus der Antwort, nicht aus einer Liste hier:
 * eine Oberfläche, die eine vierte Art anbietet, die der Server ablehnt, wäre
 * ein Schalter, der nichts tut.
 *
 * Deshalb steht auch nicht überall dasselbe Bedienelement. Zwei Möglichkeiten
 * sind ein Schalter, drei sind eine Auswahl: ein Schalter mit drei Zuständen
 * wäre ein Rätsel, und eine Auswahl mit zwei Einträgen ein Umweg um ein Ja.
 */

/** Die Wörter für jede Zustellart, in der Reihenfolge, in der sie zunehmen. */
const MODE_LABELS: Record<NotificationDeliveryMode, string> = {
  OFF: 'Gar nicht',
  IMMEDIATE: 'Sofort',
  DAILY_DIGEST: 'Einmal täglich gesammelt',
};

export function NotificationPreferencesPanel() {
  const query = useNotificationPreferences();
  const set = useSetNotificationPreference();
  const [error, setError] = React.useState<string | null>(null);

  const change = (preference: NotificationPreference, mode: NotificationDeliveryMode) => {
    setError(null);
    set.mutate(
      { kind: preference.kind, channel: preference.channel, mode },
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
          {query.data.preferences.map((preference) => (
            <PreferenceRow
              key={`${preference.kind}-${preference.channel}`}
              preference={preference}
              pending={set.isPending}
              onChange={(mode) => change(preference, mode)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PreferenceRow({
  preference,
  pending,
  onChange,
}: {
  preference: NotificationPreference;
  pending: boolean;
  onChange: (mode: NotificationDeliveryMode) => void;
}) {
  const id = `${preference.kind}-${preference.channel}`;
  const label = (
    <div>
      <Label htmlFor={id} className="text-sm">
        {preference.label}
      </Label>
      <p className="text-xs text-muted-foreground">{preference.description}</p>
    </div>
  );

  // Zwei Möglichkeiten sind ein Ja oder Nein, und dafür ist ein Schalter da.
  if (preference.modes.length <= 2) {
    const on = preference.modes.find((mode) => mode !== 'OFF') ?? 'IMMEDIATE';
    return (
      <li className="flex items-start gap-3 rounded-md border border-border p-3">
        <Switch
          id={id}
          checked={preference.mode !== 'OFF'}
          disabled={pending}
          onCheckedChange={(checked: boolean) => onChange(checked ? on : 'OFF')}
        />
        {label}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3">
      {label}
      <Select
        value={preference.mode}
        disabled={pending}
        onValueChange={(value: string | null) => {
          if (value !== null) onChange(value as NotificationDeliveryMode);
        }}
      >
        <SelectTrigger id={id} className="w-full sm:w-72">
          {/* Base UI zeigt ohne Render-Funktion den rohen Wert an. */}
          <SelectValue>{() => MODE_LABELS[preference.mode]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {preference.modes.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </li>
  );
}
