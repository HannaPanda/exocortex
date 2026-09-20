'use client';

import { BellIcon, BellOffIcon } from 'lucide-react';
import * as React from 'react';

import {
  NOTIFICATION_CATALOG,
  type PushDevice,
  type PushNotificationKind,
  pushNotificationKinds,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Switch,
} from '@exocortex/ui';

import {
  useBrowserSubscription,
  usePushDevices,
  useRegisterPushDevice,
  useRemovePushDevice,
  useSendTestPush,
  useUpdatePushDevice,
} from '@/lib/api/push-queries';
import {
  detectPushSupport,
  proposeDeviceLabel,
  type PushSupport,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push';

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * What each kind is called, out of the shared catalogue (issue #105).
 *
 * Not a second list of German words here: an occasion is called the same
 * thing wherever it is offered, and the row on this page and the row in the
 * account-wide section below it would otherwise describe the same event
 * differently.
 */
const KINDS: readonly PushNotificationKind[] = pushNotificationKinds;

/**
 * Die Geräte, auf denen dieses Konto benachrichtigt werden darf (Issue #30,
 * ADR-048).
 *
 * Eine Zeile pro Browser, weil ein Abonnement genau das ist: ein Browser auf
 * einem Gerät. Die Schalter sitzen deshalb an der Zeile und nicht oben an der
 * Seite. Das Handy in der Tasche und der Rechner auf der Arbeit wollen
 * verschiedene Dinge hören.
 */
/**
 * `useSyncExternalStore` rather than an effect: what this browser supports is
 * a fact about the platform, read during render on the client and answered as
 * "unsupported" on the server, where there is no browser at all. An effect
 * would render the panel once in the wrong state and then correct itself.
 */
const subscribeToNothing = () => () => undefined;
const supportOnServer = (): PushSupport => 'unsupported';

export function PushDevicesPanel() {
  const support = React.useSyncExternalStore(
    subscribeToNothing,
    detectPushSupport,
    supportOnServer,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const subscriptionQuery = useBrowserSubscription(support === 'supported');
  const endpoint = subscriptionQuery.data?.endpoint ?? null;
  // The device list waits for the browser to have looked itself up, so a row
  // is never rendered first as somebody else's device and then as this one.
  const knowsItself = support !== 'supported' || !subscriptionQuery.isPending;

  const devicesQuery = usePushDevices(endpoint, knowsItself);
  const register = useRegisterPushDevice();
  const update = useUpdatePushDevice();
  const remove = useRemovePushDevice();
  const test = useSendTestPush();

  const data = devicesQuery.data;
  const current = data?.devices.find((device) => device.current) ?? null;

  const enable = async () => {
    if (data?.publicKey == null) return;
    setBusy(true);
    setError(null);
    try {
      const subscription = await subscribeToPush(data.publicKey);
      await register.mutateAsync({ ...subscription, label: proposeDeviceLabel() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (current === null) return;
    setBusy(true);
    setError(null);
    try {
      await unsubscribeFromPush();
      await remove.mutateAsync(current.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="push-devices-heading">
      <div>
        <h2 id="push-devices-heading" className="text-sm font-semibold">
          Auf deinen Geräten
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">
          eXocortex kann dich auf deinen Geräten anstupsen, wenn gerade niemand hinschaut: kurz vor
          einem Termin, bei einem Kommentar an deiner Seite, oder wenn ein Agent dir etwas sagen
          will. Was ein Gerät hören soll, entscheidest du pro Gerät, denn das Handy in der Tasche
          und der Rechner auf der Arbeit wollen selten dasselbe.
        </p>
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {support === 'needs-installation' ? (
        <Alert>
          <AlertDescription>
            Auf dem iPhone und dem iPad gehen Benachrichtigungen nur, wenn eXocortex auf dem
            Startbildschirm liegt. Im Teilen-Menü „Zum Home-Bildschirm“ wählen, die App von dort
            öffnen und hier wiederkommen.
          </AlertDescription>
        </Alert>
      ) : support === 'unsupported' ? (
        <Alert>
          <AlertDescription>
            Dieser Browser kann keine Benachrichtigungen empfangen. Deine anderen Geräte stehen
            trotzdem hier und lassen sich hier auch abschalten.
          </AlertDescription>
        </Alert>
      ) : null}

      {devicesQuery.isPending ? (
        <LoadingState label="Geräte werden geladen …" variant="skeleton" rows={2} />
      ) : devicesQuery.isError ? (
        <ErrorState
          title="Geräte konnten nicht geladen werden"
          onRetry={() => void devicesQuery.refetch()}
        />
      ) : !devicesQuery.data.configured ? (
        <Alert>
          <AlertDescription>
            Diese Installation verschickt keine Benachrichtigungen. Dafür fehlt ein
            VAPID-Schlüsselpaar in der Konfiguration; <code>scripts/generate-vapid-keys.mjs</code>{' '}
            erzeugt eins.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {support === 'supported' ? (
            <div className="flex flex-wrap items-center gap-2">
              {current === null ? (
                <Button onClick={() => void enable()} disabled={busy || register.isPending}>
                  <BellIcon />
                  Dieses Gerät benachrichtigen
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => void disable()} disabled={busy}>
                    <BellOffIcon />
                    Dieses Gerät abmelden
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate({
                        title: 'Test',
                        body: 'Wenn du das liest, kommen Benachrichtigungen an.',
                        tag: 'test',
                      })
                    }
                  >
                    Testnachricht schicken
                  </Button>
                  {test.isSuccess ? (
                    <span className="text-sm text-muted-foreground">
                      {test.data.devices === 0
                        ? 'Kein Gerät hört auf Agenten-Nachrichten.'
                        : `Unterwegs an ${test.data.devices} Gerät${test.data.devices === 1 ? '' : 'e'}.`}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {devicesQuery.data.devices.length === 0 ? (
            <EmptyState
              icon={BellIcon}
              title="Noch kein Gerät angemeldet"
              description="Melde dieses Gerät an, dann steht es hier und du kannst einstellen, was es hören soll."
              className="rounded-lg border border-dashed border-border"
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {devicesQuery.data.devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  onRename={(label) => update.mutate({ deviceId: device.id, request: { label } })}
                  onToggleKind={(kind, enabled) =>
                    update.mutate({
                      deviceId: device.id,
                      request: {
                        kinds: enabled
                          ? [...device.kinds, kind]
                          : device.kinds.filter((entry) => entry !== kind),
                      },
                    })
                  }
                  onRemove={() => {
                    // Removing the row this browser is subscribed with has to
                    // end the subscription too, or the browser keeps an
                    // endpoint nothing writes to and never offers to
                    // re-register.
                    if (device.current) void disable();
                    else remove.mutate(device.id);
                  }}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function DeviceRow({
  device,
  onRename,
  onToggleKind,
  onRemove,
}: {
  device: PushDevice;
  onRename: (label: string) => void;
  onToggleKind: (kind: PushNotificationKind, enabled: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <li className="rounded-lg border border-border p-3" data-testid="push-device">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {/*
            Uncontrolled, and keyed on the stored name: typing needs no state
            here, and a rename that came from somewhere else -- another tab,
            an agent -- remounts the field with the new value instead of
            fighting whatever is half-typed in it.
          */}
          <Input
            key={device.label}
            defaultValue={device.label}
            aria-label="Name des Geräts"
            className="h-8 w-56"
            onBlur={(event) => {
              const trimmed = event.target.value.trim();
              if (trimmed !== '' && trimmed !== device.label) onRename(trimmed);
              else event.target.value = device.label;
            }}
          />
          {device.current ? <Badge variant="default">Dieses Gerät</Badge> : null}
          {device.failureCount > 0 ? (
            <Badge variant="muted">{device.failureCount} Fehlversuche</Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Entfernen
        </Button>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">
        {device.service} · angemeldet {dateTimeFormat.format(new Date(device.createdAt))}
        {device.lastDeliveredAt !== null
          ? ` · zuletzt erreicht ${dateTimeFormat.format(new Date(device.lastDeliveredAt))}`
          : ' · noch nichts zugestellt'}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {KINDS.map((kind) => (
          <div key={kind} className="flex items-start gap-3">
            <Switch
              id={`${device.id}-${kind}`}
              checked={device.kinds.includes(kind)}
              onCheckedChange={(checked: boolean) => onToggleKind(kind, checked)}
            />
            <div>
              <Label htmlFor={`${device.id}-${kind}`} className="text-sm">
                {NOTIFICATION_CATALOG[kind].label}
              </Label>
              <p className="text-xs text-muted-foreground">
                {NOTIFICATION_CATALOG[kind].description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}
