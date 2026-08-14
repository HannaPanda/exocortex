'use client';

import { catchError, type ErrorInfo } from 'next/error';

import { ErrorState } from '@exocortex/ui';

/**
 * Component-level error boundary for a panel inside `AppShell`.
 *
 * `error.tsx` (route-level) only wraps `page.tsx`, not the layout the shell
 * lives in, so a broken panel would otherwise still be caught by the segment
 * boundary and tear down the whole shell with it. Wrapping the panel itself
 * with `catchError` keeps a failure local to that panel (issue #16).
 */
function PanelErrorFallback(props: { title: string; description: string }, { retry }: ErrorInfo) {
  return (
    <ErrorState
      title={props.title}
      description={props.description}
      onRetry={() => retry()}
      data-testid="panel-error"
    />
  );
}

export const PanelErrorBoundary = catchError(PanelErrorFallback);
