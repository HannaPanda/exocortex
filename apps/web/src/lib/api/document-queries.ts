'use client';

import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type CollaborationTicketResponse,
  type CreateDocumentRequest,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentTreeResponse,
  type MoveDocumentRequest,
  type UpdateDocumentRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';
import { applyOptimisticMove } from './tree-move';

export function useDocumentTree(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.documentTree(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<DocumentTreeResponse>(`/api/workspaces/${workspaceId ?? ''}/documents/tree`),
    enabled: workspaceId !== undefined,
  });
}

export function useDocument(documentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.document(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentDetail>(`/api/documents/${documentId ?? ''}`),
    enabled: documentId !== undefined,
  });
}

export function useCreateDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateDocumentRequest) =>
      apiRequest<DocumentSummary>(`/api/workspaces/${workspaceId ?? ''}/documents`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useUpdateDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: UpdateDocumentRequest }) =>
      apiRequest<DocumentSummary>(`/api/documents/${input.documentId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useMoveDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: MoveDocumentRequest }) =>
      apiRequest<DocumentSummary>(`/api/documents/${input.documentId}/move`, {
        method: 'POST',
        body: input.request,
      }),
    /**
     * The dragged page lands where it was dropped, before the server has said so.
     *
     * The one optimistic update in the app. Everything else can wait a round trip
     * because nothing else is being *held*; a page that jumps back to its old row
     * and then forward again reads as a drag that failed and was retried.
     */
    onMutate: async (variables) => {
      if (workspaceId === undefined) return undefined;
      const key = queryKeys.documentTree(workspaceId);
      // Without this, a tree request already in flight would land afterwards and
      // overwrite the optimistic one with the pre-move order.
      await client.cancelQueries({ queryKey: key });

      const previous = client.getQueryData<DocumentTreeResponse>(key);
      if (previous === undefined) return undefined;

      const next = applyOptimisticMove(previous, variables.documentId, variables.request);
      if (next === null) return undefined;

      client.setQueryData(key, next);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (workspaceId === undefined || context?.previous === undefined) return;
      client.setQueryData(queryKeys.documentTree(workspaceId), context.previous);
    },
    onSuccess: (_document, variables) => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
      // A move across workspaces empties the current tree and fills a
      // different one; that target workspace's own tree query needs the same
      // invalidation, whether or not anyone has it open right now.
      const targetWorkspaceId = variables.request.workspaceId;
      if (targetWorkspaceId !== undefined && targetWorkspaceId !== workspaceId) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(targetWorkspaceId) });
      }
    },
  });
}

export function useArchiveDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<DocumentSummary>(`/api/documents/${documentId}/archive`, { method: 'POST' }),
    onSuccess: (document) => {
      // The open page becomes read-only, so its detail query must refresh too.
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      invalidateParentDetail(client, document.parentId);
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useRestoreDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<DocumentSummary>(`/api/documents/${documentId}/restore`, { method: 'POST' }),
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      invalidateParentDetail(client, document.parentId);
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

/**
 * Refreshes the parent's detail after a child appeared or disappeared.
 *
 * A database's detail carries `rowCount`, and its rows are ordinary child
 * documents (ADR-011), so archiving or restoring one changes a number that is
 * cached against the *parent*. The parent of a plain page has nothing that
 * depends on its children, which makes this a cheap no-op there rather than a
 * special case worth branching on.
 */
function invalidateParentDetail(client: QueryClient, parentId: string | null): void {
  if (parentId === null) return;
  void client.invalidateQueries({ queryKey: queryKeys.document(parentId) });
}

export async function fetchCollaborationTicket(
  documentId: string,
): Promise<CollaborationTicketResponse> {
  return apiRequest<CollaborationTicketResponse>(
    `/api/documents/${documentId}/collaboration-ticket`,
    { method: 'POST' },
  );
}
