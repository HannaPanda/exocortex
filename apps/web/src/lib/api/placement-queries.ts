'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { type SuggestParentResponse } from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Where a page belongs, asked of the workspace itself.
 *
 * Its own file rather than another entry in `queries.ts`: the answer is a
 * ranked read over the search index, it is only ever wanted while the dialog
 * that asks for it is open, and it must not be refetched in the background --
 * a suggestion that reshuffles itself under the pointer is a suggestion nobody
 * can act on.
 */

export const placementKeys = {
  suggestParent: (workspaceId: string, documentId: string) =>
    ['workspace', workspaceId, 'suggest-parent', documentId] as const,
  suggestParentForTitle: (workspaceId: string, title: string) =>
    ['workspace', workspaceId, 'suggest-parent-title', title] as const,
};

export function useSuggestParent(
  workspaceId: string | undefined,
  documentId: string | undefined,
  enabled = true,
): UseQueryResult<SuggestParentResponse> {
  return useQuery({
    queryKey: placementKeys.suggestParent(workspaceId ?? 'none', documentId ?? 'none'),
    queryFn: () =>
      apiRequest<SuggestParentResponse>(
        `/api/workspaces/${workspaceId ?? ''}/documents/suggest-parent`,
        { method: 'POST', body: { documentId, limit: 3 } },
      ),
    enabled: workspaceId !== undefined && documentId !== undefined && enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * The same question for a page that does not exist yet.
 *
 * `suggest-parent` takes either a `documentId` or a title plus a summary, and
 * the second form is what saving a chat as a page needs (issue #69): the text
 * is in hand, the document is not. Same ranking, same evidence, so the dialog
 * that offers it can look the same as the one for an existing page.
 */
export function useSuggestParentForTitle(input: {
  workspaceId: string | null;
  title: string;
  summary: string;
  enabled: boolean;
}): UseQueryResult<SuggestParentResponse> {
  return useQuery({
    queryKey: placementKeys.suggestParentForTitle(input.workspaceId ?? 'none', input.title),
    queryFn: () =>
      apiRequest<SuggestParentResponse>(
        `/api/workspaces/${input.workspaceId ?? ''}/documents/suggest-parent`,
        { method: 'POST', body: { title: input.title, summary: input.summary, limit: 3 } },
      ),
    enabled: input.enabled && input.workspaceId !== null && input.title.trim().length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
