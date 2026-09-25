'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type NotificationDeliveryMode,
  type NotificationKind,
  type NotificationPreference,
} from '@exocortex/contracts';
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
 * What an occasion is called and what it means, in the reader's language.
 *
 * Keyed by the kind rather than read from the preference's own `label`: the
 * device rows have no such field, and an occasion has to be called the same
 * thing in the device rows and in the mail rows, so both panels ask this one
 * hook. The API's `label` comes from the same catalogue entries.
 */
export function useNotificationKindWording() {
  const t = useTranslations('account.notifications.kinds');
  return React.useMemo(
    () => ({
      label: (kind: NotificationKind): string => t(`${kind}.label`),
      description: (kind: NotificationKind): string => t(`${kind}.description`),
    }),
    [t],
  );
}

/**
 * What this account wants to hear by mail (issue #105, ADR-052; issue #106).
 *
 * Deliberately beside the devices and not among them: an address belongs to
 * the person, a push subscription to a browser. The heading states the
 * difference, because otherwise it looks like a duplicate.
 *
 * Only what this deployment actually delivers is offered. The possible modes
 * come per row from the response, not from a list here: an interface that
 * offers a fourth mode the server refuses would be a switch that does nothing.
 *
 * That is also why the control differs between rows. Two choices are a switch,
 * three are a select: a switch with three states would be a riddle, and a
 * select with two entries a detour around a yes.
 */
export function NotificationPreferencesPanel() {
  const query = useNotificationPreferences();
  const set = useSetNotificationPreference();
  const [error, setError] = React.useState<string | null>(null);
  const t = useTranslations('account.emailPreferences');
  const tNotifications = useTranslations('account.notifications');

  const change = (preference: NotificationPreference, mode: NotificationDeliveryMode) => {
    setError(null);
    set.mutate(
      { kind: preference.kind, channel: preference.channel, mode },
      {
        onError: (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : tNotifications('failed'));
        },
      },
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="notification-preferences-heading">
      <div>
        <h2 id="notification-preferences-heading" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {error !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {query.isPending ? (
        <LoadingState label={t('loading')} variant="skeleton" rows={1} />
      ) : query.isError ? (
        <ErrorState title={t('loadError')} onRetry={() => void query.refetch()} />
      ) : query.data.preferences.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
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
  const t = useTranslations('account.emailPreferences');
  const kindWording = useNotificationKindWording();
  const id = `${preference.kind}-${preference.channel}`;
  const label = (
    <div>
      <Label htmlFor={id} className="text-sm">
        {kindWording.label(preference.kind)}
      </Label>
      <p className="text-xs text-muted-foreground">{kindWording.description(preference.kind)}</p>
    </div>
  );

  // Two choices are a yes or a no, and that is what a switch is for.
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
          {/* Base UI shows the raw value without a render function. */}
          <SelectValue>{() => t(`modes.${preference.mode}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {preference.modes.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {t(`modes.${mode}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </li>
  );
}
