'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AttentionItemResponse,
  type AttentionListResponse,
  type ResolveAttention,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { workItemKeys } from './work-item-queries';

/**
 * What needs a person (issue #139).
 *
 * The inbox spans workspaces, so its keys hang under `attention` rather than
 * under a workspace. The open list is read by the page and by the button in
 * the top bar alike; the realtime socket carries `attention.changed` for the
 * open workspace (`app-shell.tsx`), and the interval catches the others.
 */

export interface AttentionFilter {
  status: 'open' | 'settled';
  workItemId?: string;
}

export const attentionKeys = {
  all: ['attention'] as const,
  list: (filter: AttentionFilter) => ['attention', filter] as const,
};

function queryString(filter: AttentionFilter): string {
  const params = new URLSearchParams({ scope: 'for_me', status: filter.status, limit: '200' });
  if (filter.workItemId !== undefined) params.set('workItemId', filter.workItemId);
  return params.toString();
}

export function useAttention(filter: AttentionFilter): UseQueryResult<AttentionListResponse> {
  return useQuery({
    queryKey: attentionKeys.list(filter),
    queryFn: () => apiRequest<AttentionListResponse>(`/api/attention?${queryString(filter)}`),
    staleTime: 30_000,
    // Another workspace's socket room is not joined, so its new items would
    // otherwise only arrive with the next navigation.
    refetchInterval: 60_000,
  });
}

/** How many items wait on the reader, across every workspace. */
export function useOpenAttentionCount(): number {
  const open = useAttention({ status: 'open' });
  if (open.data === undefined) return 0;
  return Object.values(open.data.openCounts).reduce((sum, count) => sum + count, 0);
}

export function useResolveAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { attentionItemId: string; request: ResolveAttention }) =>
      apiRequest<AttentionItemResponse>(`/api/attention/${input.attentionItemId}/resolve`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: attentionKeys.all });
      const { workItem, workspaceId } = response.attentionItem;
      if (workItem !== null) {
        void queryClient.invalidateQueries({ queryKey: workItemKeys.detail(workItem.id) });
        void queryClient.invalidateQueries({ queryKey: workItemKeys.all(workspaceId) });
      }
    },
  });
}
