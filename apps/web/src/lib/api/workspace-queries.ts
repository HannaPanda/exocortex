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

/**
 * The caller's own order of their workspaces. Optimistic, because every arrow
 * click is one request and the row has to move under the pointer, not a round
 * trip later; the server's answer then replaces the guess.
 */
export function useReorderWorkspaces() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workspaceIds: string[]) =>
      apiRequest<WorkspaceListResponse>('/api/workspaces/order', {
        method: 'PATCH',
        body: { workspaceIds },
      }),
    onMutate: async (workspaceIds) => {
      await client.cancelQueries({ queryKey: queryKeys.workspaces });
      const previous = client.getQueryData<Workspace[]>(queryKeys.workspaces);
      if (previous !== undefined) {
        const byId = new Map(previous.map((workspace) => [workspace.id, workspace]));
        const named = new Set(workspaceIds);
        client.setQueryData<Workspace[]>(queryKeys.workspaces, [
          ...workspaceIds.flatMap((id) => byId.get(id) ?? []),
          ...previous.filter((workspace) => !named.has(workspace.id)),
        ]);
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(queryKeys.workspaces, context.previous);
      }
    },
    onSuccess: (response) => {
      client.setQueryData(queryKeys.workspaces, response.workspaces);
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
