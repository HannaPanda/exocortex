'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { TooltipProvider } from '@exocortex/ui';

import { TimeZoneSync } from '@/components/time-zone-sync';
import { ApiError } from '@/lib/api/client';
import { installErrorTranslator } from '@/lib/api/error-messages';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';

/**
 * Hands the error sentences of the active language to `messageForCode`,
 * which is read outside components (issue #98). An effect is early enough:
 * it runs on the first commit, and an `ApiError` only exists once a fetch
 * has answered, which is later.
 */
function ErrorMessages() {
  const t = useTranslations('errors.codes');
  React.useEffect(() => {
    installErrorTranslator((code) => t(code));
    return () => installErrorTranslator(null);
  }, [t]);
  return null;
}

/**
 * Client-side providers.
 *
 * Server state lives in TanStack Query only; it is never duplicated into a
 * global client store.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Authorization problems are never transient.
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ErrorMessages />
      <TimeZoneSync />
      <RealtimeProvider>
        <TooltipProvider delay={300}>{children}</TooltipProvider>
      </RealtimeProvider>
    </QueryClientProvider>
  );
}
