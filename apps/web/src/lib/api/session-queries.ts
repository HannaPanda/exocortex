'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { type CurrentSessionResponse } from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

export function useSessionQuery(): UseQueryResult<CurrentSessionResponse> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiRequest<CurrentSessionResponse>('/api/session'),
    retry: false,
    staleTime: 30_000,
  });
}
