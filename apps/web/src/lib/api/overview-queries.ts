'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type DocumentOverviewResponse,
  type RefreshDocumentOverviewResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * What an overview page says about its sub-pages (issue #53, ADR-028).
 *
 * Its own query rather than part of `useDocument`: the composition is derived
 * beside the page and changes for its own reasons -- a child was edited, a
 * refresh ran -- so it is refetched when `document.overview.updated` arrives
 * and not when the page itself is saved.
 */

export const overviewKeys = {
  overview: (documentId: string) => ['document', documentId, 'overview'] as const,
};

export function useDocumentOverview(
  documentId: string | undefined,
  enabled = true,
): UseQueryResult<DocumentOverviewResponse> {
  return useQuery({
    queryKey: overviewKeys.overview(documentId ?? 'none'),
    queryFn: () =>
      apiRequest<DocumentOverviewResponse>(`/api/documents/${documentId ?? ''}/overview`),
    enabled: documentId !== undefined && enabled,
    staleTime: 30_000,
  });
}

/**
 * Recomposes now.
 *
 * Resolves when the job is queued, not when the text exists, so nothing is
 * invalidated here: the finished composition arrives as
 * `document.overview.updated`, and the panel refetches on that. A `skipped`
 * answer is not an error and carries the reason as text.
 */
export function useRefreshDocumentOverview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<RefreshDocumentOverviewResponse>(`/api/documents/${documentId}/overview/refresh`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      // A refusal is answered immediately and has to be visible immediately;
      // the pending case is what the event covers.
      if (result.status === 'skipped') {
        void client.invalidateQueries({ queryKey: overviewKeys.overview(result.documentId) });
      }
    },
  });
}
