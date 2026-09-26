'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type ChangesetDecisionResponse,
  type ChangesetListResponse,
  type ChangesetResponse,
  type DecideChangesetRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { workItemKeys } from './work-item-queries';

/**
 * Proposed changes (issue #141).
 *
 * The browser reads and decides; proposing is what agents do. A decision
 * answers with the whole changeset, so the detail cache is written from the
 * answer; the list, the attention inbox and the work item are invalidated,
 * because deciding the last change settles the review and moves the work.
 * Changes made elsewhere arrive as `changeset.changed` (`app-shell.tsx`).
 */

export interface ChangesetListFilter {
  state: 'open' | 'closed' | 'all';
  workItemId?: string;
}

export const changesetKeys = {
  all: (workspaceId: string) => ['workspace', workspaceId, 'changesets'] as const,
  list: (workspaceId: string, filter: ChangesetListFilter) =>
    ['workspace', workspaceId, 'changesets', filter] as const,
  detail: (changesetId: string) => ['changeset', changesetId] as const,
};

export function useChangesets(
  workspaceId: string,
  filter: ChangesetListFilter,
): UseQueryResult<ChangesetListResponse> {
  return useQuery({
    queryKey: changesetKeys.list(workspaceId, filter),
    queryFn: () => {
      const params = new URLSearchParams({ state: filter.state, limit: '100' });
      if (filter.workItemId !== undefined) params.set('workItemId', filter.workItemId);
      return apiRequest<ChangesetListResponse>(
        `/api/workspaces/${workspaceId}/changesets?${params.toString()}`,
      );
    },
    staleTime: 30_000,
  });
}

export function useChangeset(changesetId: string): UseQueryResult<ChangesetResponse> {
  return useQuery({
    queryKey: changesetKeys.detail(changesetId),
    queryFn: () => apiRequest<ChangesetResponse>(`/api/changesets/${changesetId}`),
    staleTime: 15_000,
  });
}

export function useDecideChangeset(workspaceId: string, changesetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { verb: 'apply' | 'reject'; request: DecideChangesetRequest }) =>
      apiRequest<ChangesetDecisionResponse>(
        input.verb === 'apply'
          ? `/api/changesets/${changesetId}/apply`
          : `/api/changesets/${changesetId}/reject`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: (response) => {
      queryClient.setQueryData(changesetKeys.detail(changesetId), {
        changeset: response.changeset,
      });
      void queryClient.invalidateQueries({ queryKey: changesetKeys.all(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
      if (response.changeset.workItem !== null) {
        void queryClient.invalidateQueries({
          queryKey: workItemKeys.detail(response.changeset.workItem.id),
        });
      }
    },
  });
}
