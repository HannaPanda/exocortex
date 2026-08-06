'use client';

import { ShieldAlertIcon } from 'lucide-react';
import * as React from 'react';

import { EmptyState, LoadingState } from '@exocortex/ui';

import { useAdminOverview } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';

/**
 * Client-side gate for the admin section.
 *
 * This is convenience only: the real check lives in the API's AdminGuard, so a
 * user who forces the route sees an empty page instead of data. Never treat a
 * client-side role check as authorization.
 *
 * TODO(admin-role-client): `CurrentSessionResponse` (packages/contracts/src/auth.ts)
 * does not carry the global role yet, so this cannot gate on the session
 * directly. It falls back to probing `GET /api/admin/overview` and reading the
 * resulting `forbidden`/`admin_required` error instead.
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const overview = useAdminOverview();

  if (overview.isPending) {
    return <LoadingState label="Zugriff wird geprüft …" />;
  }

  if (overview.isError) {
    const code = overview.error instanceof ApiError ? overview.error.code : undefined;
    if (code === 'forbidden' || code === 'admin_required') {
      return (
        <EmptyState
          icon={ShieldAlertIcon}
          title="Kein Zugriff"
          description="Dieser Bereich ist Administratorinnen und Administratoren vorbehalten."
        />
      );
    }
    return (
      <EmptyState
        icon={ShieldAlertIcon}
        title="Verwaltung nicht verfügbar"
        description="Die Verwaltungsdaten konnten nicht geladen werden. Bitte versuche es später erneut."
      />
    );
  }

  return <>{children}</>;
}
