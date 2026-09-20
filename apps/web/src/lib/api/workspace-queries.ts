'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type UpdateWorkspaceRequest,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceListResponse,
  type WorkspaceOverviewResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

export function useWorkspaces(): UseQueryResult<Workspace[]> {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: async () => {
      const response = await apiRequest<WorkspaceListResponse>('/api/workspaces');
      return response.workspaces;
    },
  });
}

export function useWorkspaceDetail(
  workspaceId: string | undefined,
): UseQueryResult<WorkspaceDetail> {
  return useQuery({
    queryKey: queryKeys.workspaceDetail(workspaceId ?? 'none'),
    queryFn: () => apiRequest<WorkspaceDetail>(`/api/workspaces/${workspaceId ?? ''}`),
    enabled: workspaceId !== undefined,
  });
}

/**
 * The landing view's read model: recency, databases, sections and what is
 * lying around. Its own request rather than a slice of the tree, because the
 * tree cannot answer any of it -- a body edit never touches the document row.
 */
export function useWorkspaceOverview(
  workspaceId: string | undefined,
): UseQueryResult<WorkspaceOverviewResponse> {
  return useQuery({
    queryKey: queryKeys.workspaceOverview(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<WorkspaceOverviewResponse>(`/api/workspaces/${workspaceId ?? ''}/overview`),
    enabled: workspaceId !== undefined,
    staleTime: 30_000,
  });
}

export function useCreateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiRequest<Workspace>('/api/workspaces', { method: 'POST', body: { name } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useUpdateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { workspaceId: string; request: UpdateWorkspaceRequest }) =>
      apiRequest<Workspace>(`/api/workspaces/${input.workspaceId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (_workspace, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaces });
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetail(variables.workspaceId) });
    },
  });
}
