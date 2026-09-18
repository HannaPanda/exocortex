'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { type FeatureListResponse, type MarkFeaturesSeenResponse } from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * The feature registry (issue #80, ADR-040).
 *
 * Not scoped to a workspace: the registry describes the software, so the answer
 * is the same wherever the reader stands. `isNew` is not, which is why this is
 * a request rather than an import of `@exocortex/features` into the bundle.
 */

export const featureKeys = {
  list: () => ['features'] as const,
};

export function useFeatures(): UseQueryResult<FeatureListResponse> {
  return useQuery({
    queryKey: featureKeys.list(),
    queryFn: () => apiRequest<FeatureListResponse>('/api/features'),
    // The catalogue only changes on a deployment, and the badge is allowed to
    // be a few minutes stale.
    staleTime: 5 * 60_000,
  });
}

export function useMarkFeaturesSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<MarkFeaturesSeenResponse>('/api/features/seen', { method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: featureKeys.list() });
    },
  });
}
