'use client';

import * as React from 'react';

import { Separator } from '@exocortex/ui';

import { ApiTokenPanel } from './api-token-panel';
import { ConnectedAppsPanel } from './connected-apps-panel';
import { ConnectionSetupPanel } from './connection-setup-panel';

/**
 * Everything about letting a program into this account, in the order a person
 * needs it: what already has access, how to hand out access, and what to paste
 * where. The "Verbindungen" group of the settings dialog (issue #279).
 *
 * The freshly created secret lives here and nowhere else. It is passed down so
 * the setup cards can render finished commands, and it is gone once the group
 * closes -- the API returns it exactly once and this component does not
 * outlive that.
 */
export function ConnectionSettings() {
  const [freshSecret, setFreshSecret] = React.useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <ConnectedAppsPanel />
      <Separator />
      <ApiTokenPanel onTokenCreated={setFreshSecret} />
      <Separator />
      <ConnectionSetupPanel freshSecret={freshSecret} onForgetSecret={() => setFreshSecret(null)} />
    </div>
  );
}
