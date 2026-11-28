'use client';

import { Separator } from '@exocortex/ui';

import { NotificationPreferencesPanel } from './notification-preferences-panel';
import { PushDevicesPanel } from './push-devices-panel';

/**
 * Everything eXocortex reaches out to you about on its own (issue #105, ADR-052),
 * the "Benachrichtigungen" group of the settings dialog (issue #279).
 *
 * Two sections rather than one table, because the question is asked two
 * different ways: a device decides for itself, an address applies to the whole
 * account. A matrix of occasion by channel would hide that difference and offer
 * cells that do not exist.
 *
 * The device section used to sit under "Verbindungen". That group is about
 * programs you let in, and an inbox is not one.
 */
export function NotificationSettings() {
  return (
    <div className="flex flex-col gap-6">
      <PushDevicesPanel />
      <Separator />
      <NotificationPreferencesPanel />
    </div>
  );
}
