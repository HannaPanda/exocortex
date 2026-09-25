'use client';

import { BellIcon, BellOffIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
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

import { useDestructiveConfirmDialog } from '@/components/editor/destructive-confirm';
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
  identifyBrowser,
  PushSetupError,
  type PushSupport,
  subscribeToPush,
  unsubscribeFromPush,
} from '@/lib/push';

import { useNotificationKindWording } from './notification-preferences-panel';

const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/**
 * The kinds a device can hear. What each is called comes from
 * `useNotificationKindWording` (issue #105): an occasion is called the same
 * thing wherever it is offered, and the row on this page and the row in the
 * account-wide section below it would otherwise describe the same event
 * differently.
 */
const KINDS: readonly PushNotificationKind[] = pushNotificationKinds;

/*
 * The devices this account may be notified on (issue #30, ADR-048).
 *
 * One row per browser, because that is exactly what a subscription is: one
 * browser on one device. The switches therefore sit on the row and not at the
 * top of the page. The phone in the pocket and the desktop at work want to
 * hear different things.
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
  const confirmDialog = useDestructiveConfirmDialog();
  const t = useTranslations('account.pushDevices');
  const tNotifications = useTranslations('account.notifications');

  const describeFailure = (cause: unknown): string =>
    cause instanceof PushSetupError
      ? t(`errors.${cause.reason}`)
      : cause instanceof Error
        ? cause.message
        : tNotifications('failed');

  const proposeDeviceLabel = (): string => {
    const identity = identifyBrowser();
    if (identity === null) return t('unknownDevice');
    return identity.platform === null
      ? identity.browser
      : t('browserOnPlatform', { browser: identity.browser, platform: identity.platform });
  };

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
      setError(describeFailure(cause));
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
      setError(describeFailure(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="push-devices-heading">
      {confirmDialog.element}
      <div>
        <h2 id="push-devices-heading" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {support === 'needs-installation' ? (
        <Alert>
          <AlertDescription>{t('needsInstallation')}</AlertDescription>
        </Alert>
      ) : support === 'unsupported' ? (
        <Alert>
          <AlertDescription>{t('unsupported')}</AlertDescription>
        </Alert>
      ) : null}

      {devicesQuery.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={2} />
      ) : devicesQuery.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void devicesQuery.refetch()} />
      ) : !devicesQuery.data.configured ? (
        <Alert>
          <AlertDescription>
            {t.rich('notConfigured', { code: (chunks) => <code>{chunks}</code> })}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {support === 'supported' ? (
            <div className="flex flex-wrap items-center gap-2">
              {current === null ? (
                <Button onClick={() => void enable()} disabled={busy || register.isPending}>
                  <BellIcon />
                  {t('enable')}
                </Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => void disable()} disabled={busy}>
                    <BellOffIcon />
                    {t('disable')}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={test.isPending}
                    onClick={() =>
                      test.mutate({
                        title: t('testTitle'),
                        body: t('testBody'),
                        tag: 'test',
                      })
                    }
                  >
                    {t('sendTest')}
                  </Button>
                  {test.isSuccess ? (
                    <span className="text-sm text-muted-foreground">
                      {t('testResult', { devices: test.data.devices })}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {devicesQuery.data.devices.length === 0 ? (
            <EmptyState
              icon={BellIcon}
              title={t('emptyTitle')}
              description={t('emptyDescription')}
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
                  onRemove={async () => {
                    const confirmed = await confirmDialog.confirm({
                      title: t('removeTitle', { label: device.label }),
                      description: t('removeDescription'),
                      confirmLabel: t('remove'),
                    });
                    if (!confirmed) return;
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
  onRemove: () => Promise<void>;
}) {
  const t = useTranslations('account.pushDevices');
  const format = useFormatter();
  const kindWording = useNotificationKindWording();
  const meta = [
    t('registeredAt', {
      service: device.service,
      date: format.dateTime(new Date(device.createdAt), DATE_TIME),
    }),
    device.lastDeliveredAt !== null
      ? t('lastDelivered', { date: format.dateTime(new Date(device.lastDeliveredAt), DATE_TIME) })
      : t('nothingDelivered'),
  ].join(' · ');

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
            aria-label={t('deviceName')}
            className="h-8 w-56"
            onBlur={(event) => {
              const trimmed = event.target.value.trim();
              if (trimmed !== '' && trimmed !== device.label) onRename(trimmed);
              else event.target.value = device.label;
            }}
          />
          {device.current ? <Badge variant="default">{t('thisDevice')}</Badge> : null}
          {device.failureCount > 0 ? (
            <Badge variant="muted">{t('failures', { count: device.failureCount })}</Badge>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void onRemove()}>
          {t('remove')}
        </Button>
      </div>

      <p className="mt-1 text-xs text-muted-foreground">{meta}</p>

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
                {kindWording.label(kind)}
              </Label>
              <p className="text-xs text-muted-foreground">{kindWording.description(kind)}</p>
            </div>
          </div>
        ))}
      </div>
    </li>
  );
}
