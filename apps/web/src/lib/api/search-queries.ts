'use client';

import { useQuery } from '@tanstack/react-query';

import { type SearchResponse } from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

export function useSearch(workspaceId: string | undefined, query: string) {
  return useQuery({
    queryKey: queryKeys.search(workspaceId ?? 'none', query),
    queryFn: () =>
      apiRequest<SearchResponse>(
        `/api/workspaces/${workspaceId ?? ''}/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: workspaceId !== undefined && query.trim().length > 1,
    staleTime: 5_000,
  });
}
