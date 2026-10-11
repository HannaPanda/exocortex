'use client';

import { useQueryClient } from '@tanstack/react-query';

import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/**
 * Keeps the screens about delegated work current (issues #138, #139, #141,
 * #146): work items, the attention inbox, proposed changes and evals. Each event carries
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

  // An eval case or run changed, or an attempt ended (issue #146). The lists,
  // the open run and every comparison re-read; the payload carries ids only.
  useRealtimeEvent('eval.changed', (event) => {
    void queryClient.invalidateQueries({
      queryKey: ['workspace', event.workspaceId, 'eval-cases'],
    });
    void queryClient.invalidateQueries({ queryKey: ['workspace', event.workspaceId, 'eval-runs'] });
    if (event.payload.evalRunId !== null) {
      void queryClient.invalidateQueries({ queryKey: ['eval-run', event.payload.evalRunId] });
    }
    if (event.payload.evalCaseId !== null) {
      void queryClient.invalidateQueries({ queryKey: ['eval-case', event.payload.evalCaseId] });
    }
    void queryClient.invalidateQueries({ queryKey: ['eval-comparison'] });
  });

  // Something now waits on somebody, or no longer does (issue #139). The
  // inbox and the count in the top bar re-read; who an item is for is the
  // read's answer, not the event's.
  useRealtimeEvent('attention.changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['attention'] });
  });
}
