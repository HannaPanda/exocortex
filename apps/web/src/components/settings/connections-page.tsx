'use client';

import * as React from 'react';

import { AppPage, Separator } from '@exocortex/ui';

import { ApiTokenPanel } from './api-token-panel';
import { ConnectedAppsPanel } from './connected-apps-panel';
import { ConnectionSetupPanel } from './connection-setup-panel';
import { PushDevicesPanel } from './push-devices-panel';

/**
 * Everything about letting a program into this account, in the order a person
 * needs it: what already has access, how to hand out access, and what to paste
 * where.
 *
 * The freshly created secret lives here, in the page, and nowhere else. It is
 * passed down so the setup cards can render finished commands, and it is gone on
 * the next reload -- the API returns it exactly once and this page does not
 * outlive that.
 */
export function ConnectionsPage() {
  const [freshSecret, setFreshSecret] = React.useState<string | null>(null);

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">Verbindungen</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Hier hängen deine Agenten an eXocortex: Anwendungen, die sich in deinem Namen anmelden,
          Token für alles andere, die fertigen Befehle zum Einrichten, und die Geräte, auf denen du
          benachrichtigt werden willst.
        </p>
      </div>

      <ConnectedAppsPanel />
      <Separator />
      <ApiTokenPanel onTokenCreated={setFreshSecret} />
      <Separator />
      <ConnectionSetupPanel freshSecret={freshSecret} onForgetSecret={() => setFreshSecret(null)} />
      <Separator />
      {/*
        Notifications sit on this page rather than on one of their own: a
        device that may be notified is a thing this account has let in, which
        is what the page is about (issue #30).
      */}
      <PushDevicesPanel />
    </AppPage>
  );
}
