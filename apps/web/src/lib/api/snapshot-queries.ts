'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type DocumentActivityResponse,
  type DocumentDiffResponse,
  type PageHistoryResponse,
  type RestoreSnapshotBlocksRequest,
  type RestoreSnapshotBlocksResponse,
  type RestoreSnapshotResponse,
  type SnapshotContentResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * The "Aktivität" tab: the page's own history, merged server-side from
 * snapshots, the audit log and the document row (issue #20). Kept out of
 * `useDocument` for the same reason `useDocumentLinks` is: a second table,
 * only read while that tab is open.
 */
export function useDocumentActivity(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentActivity(documentId ?? 'none'),
    queryFn: () =>
      apiRequest<DocumentActivityResponse>(`/api/documents/${documentId ?? ''}/activity`),
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * Restores a page to an earlier snapshot. Destructive (the current state is
 * itself snapshotted first as a safety net, but the visible content changes
 * immediately and reaches an open editing session), so the caller is expected
 * to confirm before calling this.
 */
export function useRestoreSnapshot(documentId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) =>
      apiRequest<RestoreSnapshotResponse>(
        `/api/documents/${documentId ?? ''}/snapshots/${snapshotId}/restore`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      if (documentId === undefined) return;
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: queryKeys.documentActivity(documentId) });
      void client.invalidateQueries({ queryKey: queryKeys.documentHistory(documentId) });
      void client.invalidateQueries({ queryKey: ['document', documentId, 'diff'] });
    },
  });
}

/**
 * Compares a snapshot with a second one or with the page as it stands
 * (issue #77). Read-only and only fetched while the comparison is open, which
 * is why it is a query of its own rather than part of the activity list: a
 * diff derives both states server-side and is far more expensive than the
 * timeline beside it.
 */
export function useSnapshotDiff(
  documentId: string | undefined,
  snapshotId: string | undefined,
  against: string,
) {
  return useQuery({
    queryKey: queryKeys.documentDiff(documentId ?? 'none', snapshotId ?? 'none', against),
    queryFn: () =>
      apiRequest<DocumentDiffResponse>(
        `/api/documents/${documentId ?? ''}/snapshots/${snapshotId ?? ''}/diff?against=${encodeURIComponent(against)}`,
      ),
    enabled: documentId !== undefined && snapshotId !== undefined,
    staleTime: 10_000,
  });
}

/**
 * Takes selected blocks of a snapshot back into the current content. Changes
 * the page immediately, so the caller confirms first, the same way the full
 * restore above does.
 */
export function useRestoreSnapshotBlocks(documentId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { snapshotId: string } & RestoreSnapshotBlocksRequest) =>
      apiRequest<RestoreSnapshotBlocksResponse>(
        `/api/documents/${documentId ?? ''}/snapshots/${input.snapshotId}/restore-blocks`,
        { method: 'POST', body: { blockIds: input.blockIds } },
      ),
    onSuccess: () => {
      if (documentId === undefined) return;
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: queryKeys.documentActivity(documentId) });
      void client.invalidateQueries({ queryKey: queryKeys.documentHistory(documentId) });
      void client.invalidateQueries({ queryKey: ['document', documentId, 'diff'] });
    },
  });
}

/**
 * The page history (issue #235): every stored version, grouped, newest first,
 * one server page at a time. The cursor is the oldest version's time, so a
 * version saved while the dialog is open never shifts a page boundary.
 */
export function usePageHistory(documentId: string | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.documentHistory(documentId ?? 'none'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam !== null) params.set('before', pageParam);
      const query = params.size === 0 ? '' : `?${params.toString()}`;
      return apiRequest<PageHistoryResponse>(`/api/documents/${documentId ?? ''}/history${query}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextBefore,
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * One version, rendered. A stored version never changes, so it is fetched once
 * per dialog and kept while somebody steps back and forth through the list.
 */
export function useSnapshotContent(documentId: string | undefined, snapshotId: string | null) {
  return useQuery({
    queryKey: queryKeys.snapshotContent(documentId ?? 'none', snapshotId ?? 'none'),
    queryFn: () =>
      apiRequest<SnapshotContentResponse>(
        `/api/documents/${documentId ?? ''}/snapshots/${snapshotId ?? ''}?content=true`,
      ),
    enabled: documentId !== undefined && snapshotId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
