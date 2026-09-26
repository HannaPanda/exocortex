'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AddWorkItemNoteRequest,
  type CreateWorkItemRequest,
  type DeleteWorkItemResponse,
  type StartWorkItemRunRequest,
  type StartWorkItemRunResponse,
  type UpdateWorkItemRequest,
  type WorkItemListResponse,
  type WorkItemResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Delegated work (issue #138).
 *
 * Every mutation answers with the whole item, so the detail cache is written
 * from the answer rather than refetched, and the list is invalidated because
 * a change of status or assignee can move an item in or out of a filter.
 * Changes made elsewhere arrive as `work-item.changed` and invalidate the same
 * keys (`app-shell.tsx`).
 */

/** The list's filter, in the words of the query string. */
export interface WorkItemListFilter {
  assignee?: 'me';
  requester?: 'me';
  open: 'true' | 'false' | 'all';
}

export const workItemKeys = {
  all: (workspaceId: string) => ['workspace', workspaceId, 'work-items'] as const,
  list: (workspaceId: string, filter: WorkItemListFilter) =>
    ['workspace', workspaceId, 'work-items', filter] as const,
  detail: (workItemId: string) => ['work-item', workItemId] as const,
};

function queryString(filter: WorkItemListFilter): string {
  const params = new URLSearchParams({ open: filter.open, limit: '200' });
  if (filter.assignee !== undefined) params.set('assignee', filter.assignee);
  if (filter.requester !== undefined) params.set('requester', filter.requester);
  return params.toString();
}

export function useWorkItems(
  workspaceId: string,
  filter: WorkItemListFilter,
): UseQueryResult<WorkItemListResponse> {
  return useQuery({
    queryKey: workItemKeys.list(workspaceId, filter),
    queryFn: () =>
      apiRequest<WorkItemListResponse>(
        `/api/workspaces/${workspaceId}/work-items?${queryString(filter)}`,
      ),
    staleTime: 30_000,
  });
}

export function useWorkItem(workItemId: string): UseQueryResult<WorkItemResponse> {
  return useQuery({
    queryKey: workItemKeys.detail(workItemId),
    queryFn: () => apiRequest<WorkItemResponse>(`/api/work-items/${workItemId}`),
    staleTime: 30_000,
  });
}

function useWriteBack(workspaceId: string) {
  const queryClient = useQueryClient();
  return (response: WorkItemResponse): void => {
    queryClient.setQueryData(workItemKeys.detail(response.workItem.id), response);
    void queryClient.invalidateQueries({ queryKey: workItemKeys.all(workspaceId) });
    if (response.workItem.parentId !== null) {
      void queryClient.invalidateQueries({
        queryKey: workItemKeys.detail(response.workItem.parentId),
      });
    }
  };
}

export function useCreateWorkItem(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (request: CreateWorkItemRequest) =>
      apiRequest<WorkItemResponse>(`/api/workspaces/${workspaceId}/work-items`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: writeBack,
  });
}

export function useUpdateWorkItem(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (input: { workItemId: string; request: UpdateWorkItemRequest }) =>
      apiRequest<WorkItemResponse>(`/api/work-items/${input.workItemId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: writeBack,
  });
}

export function useAddWorkItemNote(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (input: { workItemId: string; request: AddWorkItemNoteRequest }) =>
      apiRequest<WorkItemResponse>(`/api/work-items/${input.workItemId}/notes`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: writeBack,
  });
}

export function useStartWorkItemRun(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (input: { workItemId: string; request: StartWorkItemRunRequest }) =>
      apiRequest<StartWorkItemRunResponse>(`/api/work-items/${input.workItemId}/runs`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: (response) => writeBack({ workItem: response.workItem }),
  });
}

export function useDeleteWorkItem(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workItemId: string) =>
      apiRequest<DeleteWorkItemResponse>(`/api/work-items/${workItemId}`, { method: 'DELETE' }),
    onSuccess: (_response, workItemId) => {
      queryClient.removeQueries({ queryKey: workItemKeys.detail(workItemId) });
      void queryClient.invalidateQueries({ queryKey: workItemKeys.all(workspaceId) });
    },
  });
}
