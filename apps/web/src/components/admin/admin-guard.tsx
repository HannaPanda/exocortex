'use client';

import { ShieldAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { EmptyState, LoadingState } from '@exocortex/ui';

import { useSessionQuery } from '@/lib/api/session-queries';

/**
 * Client-side gate for the admin section.
 *
 * This is convenience only: the real check lives in the API's AdminGuard, so a
 * user who forges the session's `role` still gets nothing but refusals from
 * every route underneath. Never treat a client-side role check as
 * authorization.
 *
 * It reads `role` off the session rather than probing `GET /api/admin/overview`
 * for a `forbidden`, which is what it did while the session carried no role.
 * The probe cost a request that was expected to fail and could only answer
 * after it came back; the session is loaded on every page anyway, so a person
 * who may not be here now learns it without a round trip -- and the same field
 * is what stops the header offering the area in the first place.
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const session = useSessionQuery();
  const t = useTranslations('admin.guard');

  if (session.isPending) {
    return <LoadingState label={t('checking')} />;
  }

  if (session.isError) {
    return (
      <EmptyState
        icon={ShieldAlertIcon}
        title={t('unavailableTitle')}
        description={t('unavailableDescription')}
      />
    );
  }

  if (session.data.user?.role !== 'admin') {
    return (
      <EmptyState
        icon={ShieldAlertIcon}
        title={t('forbiddenTitle')}
        description={t('forbiddenDescription')}
      />
    );
  }

  return <>{children}</>;
}
