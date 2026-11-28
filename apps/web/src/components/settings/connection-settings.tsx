'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { AppPage, Separator } from '@exocortex/ui';

import { ApiTokenPanel } from './api-token-panel';
import { ConnectedAppsPanel } from './connected-apps-panel';
import { ConnectionSetupPanel } from './connection-setup-panel';

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
  const t = useTranslations('account.connections');

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">
          {t.rich('intro', {
            link: (chunks) => (
              <Link href="/einstellungen/benachrichtigungen" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>

      <ConnectedAppsPanel />
      <Separator />
      <ApiTokenPanel onTokenCreated={setFreshSecret} />
      <Separator />
      <ConnectionSetupPanel freshSecret={freshSecret} onForgetSecret={() => setFreshSecret(null)} />
    </AppPage>
  );
}
