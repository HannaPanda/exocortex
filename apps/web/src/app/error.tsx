'use client';

import { AlertTriangleIcon } from 'lucide-react';
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
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangleIcon className="size-7 text-destructive-text" aria-hidden />
      <h1 className="exocortex-page-title">Diese Ansicht konnte nicht geladen werden</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Bitte versuche es erneut. Wenn das Problem bleibt, prüfe deine Verbindung. Ein gestarteter
        KI-Lauf arbeitet im Hintergrund weiter; sein Verlauf steht nach dem Neuladen vollständig im
        Chat.
      </p>
      <Button variant="outline" onClick={() => retry()}>
        Erneut versuchen
      </Button>
    </div>
  );
}
