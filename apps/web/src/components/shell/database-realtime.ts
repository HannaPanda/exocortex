'use client';

import { useQueryClient } from '@tanstack/react-query';

import { invalidateDatabaseAfterEvent } from '@/lib/api/database-queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/**
 * Keeps the database screens current while a row, a column or a view changes
 * somewhere else: another tab, another member, an agent (issue #254). The table
 * and a row's page header show the same values, so an edit in either reaches
 * the other without a reload. Each event names only the database; what the
 * browser holds about it is marked stale and what is on screen is read again.
 */
export function useDatabaseRealtime(): void {
  const queryClient = useQueryClient();

  useRealtimeEvent('database.row.updated', (event) =>
    invalidateDatabaseAfterEvent(queryClient, {
      kind: 'row',
      documentId: event.payload.documentId,
    }),
  );
  useRealtimeEvent('database.property.changed', (event) =>
    invalidateDatabaseAfterEvent(queryClient, {
      kind: 'property',
      documentId: event.payload.documentId,
    }),
  );
  useRealtimeEvent('database.view.changed', (event) =>
    invalidateDatabaseAfterEvent(queryClient, {
      kind: 'view',
      documentId: event.payload.documentId,
    }),
  );
}
