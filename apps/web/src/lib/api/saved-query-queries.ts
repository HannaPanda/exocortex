'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateSavedQueryRequest,
  type DeleteSavedQueryResponse,
  type PreviewSavedQueryRequest,
  type ReorderSavedQueryRequest,
  type SavedQueryDefinition,
  type SavedQueryListResponse,
  type SavedQueryResponse,
  type SavedQueryResultsResponse,
  type UpdateSavedQueryRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * The results are deliberately not cached for long. A saved query exists
 * because its answer moves, and a list that shows yesterday's answer for five
 * minutes is exactly the thing the feature was supposed to replace. Thirty
 * seconds is short enough that switching between two views re-reads, long
 * enough that a page with three query blocks does not fire three requests per
 * keystroke somewhere else.
 */
const RESULTS_STALE_TIME = 30_000;

export const savedQueryKeys = {
  list: (workspaceId: string) => ['workspace', workspaceId, 'saved-queries'] as const,
  detail: (savedQueryId: string) => ['saved-query', savedQueryId] as const,
  results: (savedQueryId: string, limit: number | undefined) =>
    ['saved-query', savedQueryId, 'results', limit ?? 'default'] as const,
  preview: (workspaceId: string, definition: SavedQueryDefinition) =>
    ['workspace', workspaceId, 'saved-query-preview', JSON.stringify(definition)] as const,
};

export function useSavedQueries(
  workspaceId: string | undefined,
): UseQueryResult<SavedQueryListResponse> {
  return useQuery({
    queryKey: savedQueryKeys.list(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<SavedQueryListResponse>(`/api/workspaces/${workspaceId ?? ''}/saved-queries`),
    enabled: workspaceId !== undefined,
    staleTime: 60_000,
  });
}

export function useSavedQuery(
  savedQueryId: string | undefined,
): UseQueryResult<SavedQueryResponse> {
  return useQuery({
    queryKey: savedQueryKeys.detail(savedQueryId ?? 'none'),
    queryFn: () => apiRequest<SavedQueryResponse>(`/api/saved-queries/${savedQueryId ?? ''}`),
    enabled: savedQueryId !== undefined,
    staleTime: 60_000,
  });
}

export function useSavedQueryResults(
  savedQueryId: string | undefined,
  limit?: number,
): UseQueryResult<SavedQueryResultsResponse> {
  return useQuery({
    queryKey: savedQueryKeys.results(savedQueryId ?? 'none', limit),
    queryFn: () =>
      apiRequest<SavedQueryResultsResponse>(
        `/api/saved-queries/${savedQueryId ?? ''}/results${limit === undefined ? '' : `?limit=${limit}`}`,
      ),
    enabled: savedQueryId !== undefined,
    staleTime: RESULTS_STALE_TIME,
  });
}

/**
 * Runs a definition nobody has saved. `enabled` is the caller's decision:
 * the search area holds a definition the whole time it is open and only asks
 * once the reader has narrowed it down to something worth answering.
 */
export function useSavedQueryPreview(
  workspaceId: string | undefined,
  definition: SavedQueryDefinition,
  enabled: boolean,
): UseQueryResult<SavedQueryResultsResponse> {
  return useQuery({
    queryKey: savedQueryKeys.preview(workspaceId ?? 'none', definition),
    queryFn: () => {
      const body: PreviewSavedQueryRequest = { definition };
      return apiRequest<SavedQueryResultsResponse>(
        `/api/workspaces/${workspaceId ?? ''}/saved-queries/preview`,
        { method: 'POST', body },
      );
    },
    enabled: workspaceId !== undefined && enabled,
    staleTime: RESULTS_STALE_TIME,
  });
}

export function useCreateSavedQuery(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateSavedQueryRequest) =>
      apiRequest<SavedQueryResponse>(`/api/workspaces/${workspaceId}/saved-queries`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: savedQueryKeys.list(workspaceId) });
    },
  });
}

export function useUpdateSavedQuery(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { savedQueryId: string; request: UpdateSavedQueryRequest }) =>
      apiRequest<SavedQueryResponse>(`/api/saved-queries/${input.savedQueryId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: savedQueryKeys.list(workspaceId) });
      void client.invalidateQueries({ queryKey: savedQueryKeys.detail(input.savedQueryId) });
      // The question changed, so every answer cached for it is about a
      // different question now.
      void client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'saved-query' && query.queryKey[1] === input.savedQueryId,
      });
    },
  });
}

export function useReorderSavedQuery(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { savedQueryId: string; request: ReorderSavedQueryRequest }) =>
      apiRequest<SavedQueryResponse>(`/api/saved-queries/${input.savedQueryId}/position`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: savedQueryKeys.list(workspaceId) });
    },
  });
}

export function useDeleteSavedQuery(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (savedQueryId: string) =>
      apiRequest<DeleteSavedQueryResponse>(`/api/saved-queries/${savedQueryId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: savedQueryKeys.list(workspaceId) });
    },
  });
}
