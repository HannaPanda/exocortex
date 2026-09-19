'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { type DocumentFragmentResponse } from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * What a transclusion shows (issue #78, ADR-045).
 *
 * The key sits under `['document', <source id>, …]` on purpose: the shell
 * invalidates that prefix whenever a page changes, is materialized or is
 * written from outside the editor, so a transclusion picks the change up
 * without this module subscribing to anything of its own. Which also says what
 * the freshness really is: a change made in the source's open editor reaches
 * the embedding page when that page has been materialized, not keystroke by
 * keystroke. The block shows the source, not the source's live session.
 */
export const transclusionKeys = {
  fragment: (documentId: string, blockId: string | null, outline: boolean) =>
    ['document', documentId, 'fragment', blockId ?? 'page', outline ? 'outline' : 'plain'] as const,
};

/** Freshness of a fragment. Short: the point of the block is to be current. */
const FRAGMENT_STALE_TIME = 15_000;

export function useDocumentFragment(
  documentId: string | null,
  blockId: string | null,
  options: { outline?: boolean } = {},
): UseQueryResult<DocumentFragmentResponse> {
  const outline = options.outline ?? false;
  return useQuery({
    queryKey: transclusionKeys.fragment(documentId ?? 'none', blockId, outline),
    queryFn: () => {
      const search = new URLSearchParams();
      if (blockId !== null) search.set('blockId', blockId);
      if (outline) search.set('outline', 'true');
      return apiRequest<DocumentFragmentResponse>(
        `/api/documents/${documentId ?? ''}/fragment?${search.toString()}`,
      );
    },
    enabled: documentId !== null,
    staleTime: FRAGMENT_STALE_TIME,
    // A source that was deleted or that this reader may not open answers 403 or
    // 404. Retrying that only delays the state the block should be showing.
    retry: false,
  });
}
