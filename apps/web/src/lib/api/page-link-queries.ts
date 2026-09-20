'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  type DocumentLinksResponse,
  type RelatedDocumentsResponse,
  type ResolveDocumentLinkResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * The reference index of a page: who points at it, and what it points at.
 *
 * Kept out of `useDocument` on purpose — it is a second table, it is only read
 * when the Verweise tab is open, and it is refreshed by materialization rather
 * than by the request that changed the page.
 */
export function useDocumentLinks(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentLinks(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentLinksResponse>(`/api/documents/${documentId ?? ''}/links`),
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * Pages that resemble the open one without being linked to it (issue #33).
 *
 * Read in the same panel as the references but kept a separate query: the
 * answer depends on semantic search being on and on the page having been
 * embedded, so it can be slower, be empty for its own reasons, and fail
 * without taking the references down with it. Cached longer than the links
 * because the neighbourhood of a page moves at the pace of the whole
 * workspace, not at the pace of this page's own edits.
 */
export function useRelatedDocuments(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentRelated(documentId ?? 'none'),
    queryFn: () =>
      apiRequest<RelatedDocumentsResponse>(`/api/documents/${documentId ?? ''}/related`),
    enabled: documentId !== undefined && enabled,
    staleTime: 60_000,
  });
}

/** What a reference to another page carries: an identity, a title, or both. */
export interface PageLinkReference {
  /** `pageLink`'s `documentId`. Absent for a `[[Titel]]` mark or a page mention. */
  documentId?: string | null;
  /** The stored display title. */
  title?: string;
}

/**
 * Resolves a reference to another page to the document(s) it means.
 *
 * Shared by the click path (`link-navigation.tsx`, via `queryClient.fetchQuery`)
 * and the `pageLink` block's own node view (`usePageLinkResolution` below), so
 * both read from the same cache entry per reference. The identity is part of
 * the cache key, because two links with the same label may well mean two
 * different pages (issue #14).
 */
export function pageLinkQueryOptions(workspaceId: string, reference: PageLinkReference) {
  const query = new URLSearchParams();
  if (typeof reference.title === 'string' && reference.title.length > 0) {
    query.set('title', reference.title);
  }
  if (typeof reference.documentId === 'string' && reference.documentId.length > 0) {
    query.set('documentId', reference.documentId);
  }
  return {
    queryKey: queryKeys.pageLink(workspaceId, reference),
    queryFn: () =>
      apiRequest<ResolveDocumentLinkResponse>(
        `/api/workspaces/${workspaceId}/documents/resolve?${query.toString()}`,
      ),
    staleTime: 30_000,
  };
}

/** For the page-link block, which shows its resolution state before anyone clicks it. */
export function usePageLinkResolution(
  workspaceId: string,
  reference: PageLinkReference,
): UseQueryResult<ResolveDocumentLinkResponse> {
  const hasTitle = typeof reference.title === 'string' && reference.title.length > 0;
  const hasIdentity = typeof reference.documentId === 'string' && reference.documentId.length > 0;
  return useQuery({
    ...pageLinkQueryOptions(workspaceId, reference),
    enabled: hasTitle || hasIdentity,
  });
}
