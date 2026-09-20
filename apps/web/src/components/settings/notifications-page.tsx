'use client';

import { AppPage, Separator } from '@exocortex/ui';

import { NotificationPreferencesPanel } from './notification-preferences-panel';
import { PushDevicesPanel } from './push-devices-panel';

/**
 * Alles, worüber eXocortex dich von sich aus anspricht (Issue #105, ADR-052).
 *
 * Zwei Bereiche und nicht eine Tabelle, weil die Frage zweimal anders gestellt
 * wird: ein Gerät entscheidet für sich, eine Adresse gilt fürs ganze Konto.
 * Eine Matrix aus Anlass mal Kanal würde diesen Unterschied verstecken und
 * dabei Felder anbieten, die es gar nicht gibt.
 *
 * Vorher stand der Geräte-Bereich unter „Verbindungen“. Dort ging es um
 * Programme, die man einlässt, und ein Postfach ist keins.
 */
export function NotificationsPage() {
  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">Benachrichtigungen</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Wann eXocortex dich von sich aus erreicht, und auf welchem Weg. Auf deinen Geräten
          entscheidest du pro Gerät, per Mail für das ganze Konto.
        </p>
      </div>

      <PushDevicesPanel />
      <Separator />
      <NotificationPreferencesPanel />
    </AppPage>
  );
}
