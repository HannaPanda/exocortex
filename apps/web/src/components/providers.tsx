'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

import { TooltipProvider } from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';

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
      <RealtimeProvider>
        <TooltipProvider delay={300}>{children}</TooltipProvider>
      </RealtimeProvider>
    </QueryClientProvider>
  );
}
