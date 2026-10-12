'use client';

import { useQuery } from '@tanstack/react-query';

import { type KnowledgeMapResponse } from '@exocortex/contracts';

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
