'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type MemoryFactListResponse,
  type MemoryFactPromoteRequest,
  type MemoryFactPromoteResponse,
  type MemoryFactStatus,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * The distilled facts of the agent memory (issue #46, ADR-021).
 *
 * Deployment-wide like the entity layer, and for the same reason: a fact is a
 * page in the memory workspace, and which project it belongs to is a key on the
 * row rather than a workspace.
 */

export const memoryKeys = {
  facts: (query: { project: string | null; status: MemoryFactStatus }) =>
    ['memory-facts', query.project ?? 'all', query.status] as const,
  all: ['memory-facts'] as const,
};

export function useMemoryFacts(query: {
  project: string | null;
  status: MemoryFactStatus;
}): UseQueryResult<MemoryFactListResponse> {
  return useQuery({
    queryKey: memoryKeys.facts(query),
    queryFn: () => {
      const params = new URLSearchParams({ status: query.status, limit: '100' });
      if (query.project !== null) params.set('project', query.project);
      return apiRequest<MemoryFactListResponse>(`/api/memory/facts?${params.toString()}`);
    },
  });
}

/**
 * Copies one fact into a curated workspace, as a page of its own.
 *
 * ADR-021 keeps this a human act on purpose: the memory may hold something to
 * be true without it belonging in the brain a person reads. The tool exists for
 * an agent that was asked to do it; this is the button that was missing for the
 * person whose decision it is.
 */
export function usePromoteMemoryFact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { factId: string; request: MemoryFactPromoteRequest }) =>
      apiRequest<MemoryFactPromoteResponse>(`/api/memory/facts/${input.factId}/promote`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: memoryKeys.all }),
  });
}
