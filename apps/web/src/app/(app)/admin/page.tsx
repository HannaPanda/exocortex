'use client';

import { useTranslations } from 'next-intl';

import { ErrorState, LoadingState } from '@exocortex/ui';

import { OverviewCards } from '@/components/admin/overview-cards';
import { useAdminOverview } from '@/lib/api/admin-queries';

export default function AdminOverviewPage() {
  const overview = useAdminOverview();
  const t = useTranslations('admin.overview');

  if (overview.isPending) {
    return <LoadingState label={t('loading')} variant="skeleton" rows={4} />;
  }

  if (overview.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void overview.refetch()} />;
  }

  return <OverviewCards overview={overview.data} />;
}
