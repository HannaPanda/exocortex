'use client';

import { useQueryClient } from '@tanstack/react-query';

import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/**
 * Keeps the screens about delegated work current (issues #138, #139, #141):
 * work items, the attention inbox and proposed changes. Each event carries
 * only ids, so a change re-reads the lists and the open detail. Out of the
 * shell because the shell is a layout, and these three belong together.
 */
export function useDelegatedWorkRealtime(): void {
  const queryClient = useQueryClient();

  // A work item changed, possibly through an agent (issue #138). Lists and the
  // open detail view re-read; the payload carries only the id.
  useRealtimeEvent('work-item.changed', (event) => {
    void queryClient.invalidateQueries({
      queryKey: ['workspace', event.workspaceId, 'work-items'],
    });
    void queryClient.invalidateQueries({ queryKey: ['work-item', event.payload.workItemId] });
  });

  // A proposal was started, handed in or decided (issue #141).
  useRealtimeEvent('changeset.changed', (event) => {
    void queryClient.invalidateQueries({
      queryKey: ['workspace', event.workspaceId, 'changesets'],
    });
    void queryClient.invalidateQueries({ queryKey: ['changeset', event.payload.changesetId] });
  });

  // Something now waits on somebody, or no longer does (issue #139). The
  // inbox and the count in the top bar re-read; who an item is for is the
  // read's answer, not the event's.
  useRealtimeEvent('attention.changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['attention'] });
  });
}
