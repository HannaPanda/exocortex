'use client';

import { AlertTriangleIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '@exocortex/ui';

/**
 * Error boundary for everything inside `(app)/layout.tsx`.
 *
 * Scoped to this segment rather than the root `error.tsx` on purpose: a
 * segment boundary wraps `page.tsx` and nested layouts, but not the
 * `layout.tsx` above it in the same segment (Next.js). `AppShell` -- and with
 * it the AI panel -- lives in that layout, so a page that fails to render
 * still leaves a running AI run's chat on screen instead of tearing the whole
 * shell down (issue #16).
 */
export default function AppSegmentError({ retry }: { error: Error; retry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <AlertTriangleIcon className="size-7 text-destructive-text" aria-hidden />
      <h1 className="text-lg font-semibold">Diese Seite konnte nicht geladen werden</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Der Rest der Anwendung läuft weiter. Ein gestarteter KI-Lauf arbeitet im Hintergrund
        weiter; sein Verlauf steht nach dem Neuladen vollständig im Chat.
      </p>
      <Button variant="outline" onClick={() => retry()}>
        Erneut versuchen
      </Button>
    </div>
  );
}
