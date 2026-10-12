'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type KnowledgeMapAppearancePatch,
  type KnowledgeMapAppearanceResponse,
  type KnowledgeMapResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/** Kept here: only the map reads it, and only the map invalidates it. */
export const knowledgeMapKey = (workspaceId: string) =>
  ['workspace', workspaceId, 'knowledge-map'] as const;

/**
 * The knowledge map of a workspace (issue #189). Never refetched on a timer:
 * the map listens to the workspace's events and asks again when one of them
 * changes a point or a line, which is both fresher and cheaper than polling.
 */
export function useKnowledgeMap(workspaceId: string) {
  return useQuery({
    queryKey: knowledgeMapKey(workspaceId),
    queryFn: () => apiRequest<KnowledgeMapResponse>(`/api/workspaces/${workspaceId}/map`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export const knowledgeMapAppearanceKey = ['me', 'knowledge-map-appearance'] as const;

/** How the map looks to the signed-in person (issue #189). Theirs on every device. */
export function useKnowledgeMapAppearance() {
  return useQuery({
    queryKey: knowledgeMapAppearanceKey,
    queryFn: () => apiRequest<KnowledgeMapAppearanceResponse>('/api/me/knowledge-map-appearance'),
    staleTime: 30_000,
  });
}

/** Saves a change to the look, or `'reset'` for the defaults. */
export function useSetKnowledgeMapAppearance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: KnowledgeMapAppearancePatch | 'reset') =>
      apiRequest<KnowledgeMapAppearanceResponse>(
        '/api/me/knowledge-map-appearance',
        change === 'reset' ? { method: 'DELETE' } : { method: 'PATCH', body: change },
      ),
    onSuccess: (result) => client.setQueryData(knowledgeMapAppearanceKey, result),
  });
}
