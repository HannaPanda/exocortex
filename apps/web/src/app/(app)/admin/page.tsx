'use client';

import { ErrorState, LoadingState } from '@exocortex/ui';

import { OverviewCards } from '@/components/admin/overview-cards';
import { useAdminOverview } from '@/lib/api/admin-queries';

export default function AdminOverviewPage() {
  const overview = useAdminOverview();

  if (overview.isPending) {
    return <LoadingState label="Übersicht wird geladen …" variant="skeleton" rows={4} />;
  }

  if (overview.isError) {
    return (
      <ErrorState
        title="Übersicht konnte nicht geladen werden"
        onRetry={() => void overview.refetch()}
      />
    );
  }

  return <OverviewCards overview={overview.data} />;
}
