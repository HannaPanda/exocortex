'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type AiFillRun,
  type AiFillRunListResponse,
  type AiFillStartResponse,
  type DatabaseProperty,
  type SetDatabasePropertyAiRequest,
  type StartAiFillRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { databaseQueryKeys } from './database-queries';

/**
 * A column's AI instruction and the batches that fill it (issue #237,
 * ADR-099). The cells a batch wrote arrive as ordinary row changes; what a
 * value write cannot say (a cell that failed, the batch's own state) arrives
 * as `database.ai_fill.changed`, which invalidates both lists below.
 */
export const aiFillQueryKeys = {
  active: (documentId: string) => ['database', documentId, 'ai-fills', 'active'] as const,
};

function invalidateAfterFill(client: ReturnType<typeof useQueryClient>, documentId: string): void {
  void client.invalidateQueries({ queryKey: aiFillQueryKeys.active(documentId) });
  void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
  void client.invalidateQueries({ queryKey: ['database', 'row'] });
}

export function useSetPropertyAi(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { propertyId: string; request: SetDatabasePropertyAiRequest }) =>
      apiRequest<DatabaseProperty>(
        `/api/documents/${documentId}/properties/${input.propertyId}/ai`,
        { method: 'PATCH', body: input.request },
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: databaseQueryKeys.properties(documentId) }),
  });
}

export function useRemovePropertyAi(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) =>
      apiRequest<DatabaseProperty>(`/api/documents/${documentId}/properties/${propertyId}/ai`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: databaseQueryKeys.properties(documentId) }),
  });
}

export function useStartAiFill(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: StartAiFillRequest) =>
      apiRequest<AiFillStartResponse>(`/api/documents/${documentId}/ai-fills`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (result) => {
      if (result.run !== null) invalidateAfterFill(client, documentId);
    },
  });
}

export function useCancelAiFill(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest<AiFillRun>(`/api/ai-fills/${runId}/cancel`, { method: 'POST' }),
    onSettled: () => invalidateAfterFill(client, documentId),
  });
}

export function useRetryAiFill(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest<AiFillStartResponse>(`/api/ai-fills/${runId}/retry`, { method: 'POST' }),
    onSuccess: () => invalidateAfterFill(client, documentId),
  });
}

/**
 * The batches of a database that are still working, for the progress strip.
 * Polled slowly while one runs, because a missed event must not leave a bar
 * standing still forever; the events are what makes it move promptly.
 */
export function useActiveAiFills(documentId: string, enabled: boolean) {
  return useQuery({
    queryKey: aiFillQueryKeys.active(documentId),
    queryFn: () =>
      apiRequest<AiFillRunListResponse>(`/api/documents/${documentId}/ai-fills?active=true`),
    enabled,
    refetchInterval: (query) => ((query.state.data?.runs.length ?? 0) > 0 ? 5_000 : false),
  });
}

export function invalidateAiFillAfterEvent(
  client: ReturnType<typeof useQueryClient>,
  documentId: string,
): void {
  invalidateAfterFill(client, documentId);
}
