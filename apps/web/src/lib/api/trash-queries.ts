'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type DeleteDocumentsResponse,
  type DocumentDeletionPreviewsResponse,
  type TrashResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/** The server's cap on one request (`deleteDocumentsRequestSchema`). */
const MAX_IDS_PER_REQUEST = 100;

/**
 * Splits a selection into rounds the server accepts. "Alle auswählen" in a
 * trash with more than a hundred top-level pages would otherwise be refused
 * outright. Each round is its own transaction: a failure part way leaves the
 * later rounds in the trash, never half of one.
 */
function inRounds(documentIds: readonly string[]): string[][] {
  const rounds: string[][] = [];
  for (let start = 0; start < documentIds.length; start += MAX_IDS_PER_REQUEST) {
    rounds.push(documentIds.slice(start, start + MAX_IDS_PER_REQUEST));
  }
  return rounds;
}

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
    mutationFn: async (documentIds: string[]): Promise<DocumentDeletionPreviewsResponse> => {
      const previews: DocumentDeletionPreviewsResponse['previews'] = [];
      for (const round of inRounds(documentIds)) {
        const answer = await apiRequest<DocumentDeletionPreviewsResponse>(
          `/api/workspaces/${workspaceId ?? ''}/trash/deletion-preview`,
          { method: 'POST', body: { documentIds: round } },
        );
        previews.push(...answer.previews);
      }
      return { previews };
    },
  });
}

/** Deletes archived pages for good. Nothing brings them back. */
export function useDeleteDocuments(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (documentIds: string[]): Promise<DeleteDocumentsResponse> => {
      const total: DeleteDocumentsResponse = {
        deletedIds: [],
        deletedCount: 0,
        attachmentCount: 0,
        unresolvedLinkCount: 0,
      };
      for (const round of inRounds(documentIds)) {
        const answer = await apiRequest<DeleteDocumentsResponse>(
          `/api/workspaces/${workspaceId ?? ''}/trash/delete`,
          { method: 'POST', body: { documentIds: round } },
        );
        total.deletedIds.push(...answer.deletedIds);
        total.deletedCount += answer.deletedCount;
        total.attachmentCount += answer.attachmentCount;
        total.unresolvedLinkCount += answer.unresolvedLinkCount;
      }
      return total;
    },
    onSuccess: (result) => {
      for (const documentId of result.deletedIds) {
        client.removeQueries({ queryKey: queryKeys.document(documentId) });
      }
    },
    // Settled rather than success: a round that failed after others went
    // through still changed the trash, and the list has to show that.
    onSettled: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.trash(workspaceId) });
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
        // References to the deleted pages are unresolved now, wherever they sit.
        void client.invalidateQueries({ queryKey: queryKeys.pageLinks(workspaceId) });
      }
    },
  });
}
