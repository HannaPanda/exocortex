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
  // A row is a page (ADR-011): one created, duplicated, put in the trash,
  // restored or moved away arrives as a page event naming its parent, and a
  // table showing that parent's rows has to follow (issue #244). A page whose
  // parent is no database invalidates nothing that is cached.
  const parentChanged = (parentId: string | null): void => {
    if (parentId === null) return;
    void queryClient.invalidateQueries({ queryKey: ['database', parentId, 'rows'] });
  };
  useRealtimeEvent('document.created', (event) => parentChanged(event.payload.document.parentId));
  useRealtimeEvent('document.archived', (event) => parentChanged(event.payload.document.parentId));
  useRealtimeEvent('document.restored', (event) => parentChanged(event.payload.document.parentId));
  useRealtimeEvent('document.moved', (event) => {
    parentChanged(event.payload.document.parentId);
    parentChanged(event.payload.previousParentId);
  });
  useRealtimeEvent('database.view.changed', (event) =>
    invalidateDatabaseAfterEvent(queryClient, {
      kind: 'view',
      documentId: event.payload.documentId,
    }),
  );
}
