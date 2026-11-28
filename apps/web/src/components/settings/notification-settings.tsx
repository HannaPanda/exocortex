'use client';

import { useTranslations } from 'next-intl';

import { AppPage, Separator } from '@exocortex/ui';

import { NotificationPreferencesPanel } from './notification-preferences-panel';
import { PushDevicesPanel } from './push-devices-panel';

/**
 * Everything eXocortex reaches out to you about on its own (issue #105, ADR-052).
 *
 * Two sections rather than one table, because the question is asked two
 * different ways: a device decides for itself, an address applies to the whole
 * account. A matrix of occasion by channel would hide that difference and offer
 * cells that do not exist.
 *
 * The device section used to sit under "Verbindungen". That page is about
 * programs you let in, and an inbox is not one.
 */
export function NotificationsPage() {
  const t = useTranslations('account.notifications');
  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      <PushDevicesPanel />
      <Separator />
      <NotificationPreferencesPanel />
    </AppPage>
  );
}
