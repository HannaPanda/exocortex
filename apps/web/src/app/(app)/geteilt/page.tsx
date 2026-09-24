import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoadingState } from '@exocortex/ui';

import { SharesPage } from '@/components/shell/shares-page';

export const metadata: Metadata = { title: 'Freigaben' };

export default function SharesRoute() {
  // The tab lives in the query string, and a component that reads it has to
  // sit under a Suspense boundary or the whole route renders on the client.
  return (
    <Suspense fallback={<LoadingState label="Freigaben werden geladen …" />}>
      <SharesPage />
    </Suspense>
  );
}
