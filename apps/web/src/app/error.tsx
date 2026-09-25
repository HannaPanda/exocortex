'use client';

import { AlertTriangleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button } from '@exocortex/ui';

/**
 * Root error boundary. Technical details stay out of the UI.
 *
 * This one tears down the whole app, `AppShell` and any running AI panel
 * included -- it only wraps `page.tsx`, so an error here means the segment
 * boundary in `(app)/error.tsx` did not already catch it (issue #16).
 */
export default function RouteError({ retry }: { error: Error; retry: () => void }) {
  const t = useTranslations('errors.boundary');
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangleIcon className="size-7 text-destructive-text" aria-hidden />
      <h1 className="exocortex-page-title">{t('viewTitle')}</h1>
      <p className="max-w-md text-sm text-muted-foreground">{t('viewBody')}</p>
      <Button variant="outline" onClick={() => retry()}>
        {t('retry')}
      </Button>
    </div>
  );
}
