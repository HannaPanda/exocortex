'use client';

import { AlertTriangleIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@exocortex/ui';

/** Route-level error boundary. Technical details stay out of the UI. */
export default function RouteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangleIcon className="size-7 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold">Diese Ansicht konnte nicht geladen werden</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Bitte versuche es erneut. Wenn das Problem bleibt, prüfe deine Verbindung.
      </p>
      <Button variant="outline" onClick={reset}>
        Erneut versuchen
      </Button>
    </div>
  );
}
