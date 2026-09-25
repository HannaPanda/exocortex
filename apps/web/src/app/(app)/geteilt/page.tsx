import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { LoadingState } from '@exocortex/ui';

import { SharesPage } from '@/components/shell/shares-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shares.meta');
  return { title: t('sharesTitle') };
}

export default async function SharesRoute() {
  const t = await getTranslations('shares.common');
  // The tab lives in the query string, and a component that reads it has to
  // sit under a Suspense boundary or the whole route renders on the client.
  return (
    <Suspense fallback={<LoadingState label={t('loading')} />}>
      <SharesPage />
    </Suspense>
  );
}
