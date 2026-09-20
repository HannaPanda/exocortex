'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type DeleteDocumentsResponse,
  type DocumentDeletionPreviewsResponse,
  type TrashResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * The trash with its shape: what was archived, what came along, and when.
 *
 * Its own query rather than a slice of the tree, because the tree is loaded on
 * every page view and this is read only when somebody opens the trash.
 */
export function useTrash(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trash(workspaceId ?? 'none'),
    queryFn: () => apiRequest<TrashResponse>(`/api/workspaces/${workspaceId ?? ''}/trash`),
    enabled: workspaceId !== undefined && enabled,
  });
}

/**
 * What deleting this selection would take with it. A mutation rather than a
 * query: it is asked once, for one selection, at the moment the dialog opens.
 */
export function useDeletionPreviews(workspaceId: string | undefined) {
  return useMutation({
    mutationFn: (documentIds: string[]) =>
      apiRequest<DocumentDeletionPreviewsResponse>(
        `/api/workspaces/${workspaceId ?? ''}/trash/deletion-preview`,
        { method: 'POST', body: { documentIds } },
      ),
  });
}

/** Deletes archived pages for good. Nothing brings them back. */
export function useDeleteDocuments(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentIds: string[]) =>
      apiRequest<DeleteDocumentsResponse>(`/api/workspaces/${workspaceId ?? ''}/trash/delete`, {
        method: 'POST',
        body: { documentIds },
      }),
    onSuccess: (result) => {
      for (const documentId of result.deletedIds) {
        client.removeQueries({ queryKey: queryKeys.document(documentId) });
      }
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.trash(workspaceId) });
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
        // References to the deleted pages are unresolved now, wherever they sit.
        void client.invalidateQueries({ queryKey: queryKeys.pageLinks(workspaceId) });
      }
    },
  });
}
