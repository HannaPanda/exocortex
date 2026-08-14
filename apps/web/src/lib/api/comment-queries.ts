'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import * as React from 'react';

import type {
  CommentListResponse,
  CommentResponse,
  CreateCommentRequest,
  DeleteCommentResponse,
} from '@exocortex/contracts';

import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

import { apiRequest } from './client';

/**
 * Comments of the open page (issue #18).
 *
 * Kept in a file of its own, next to `database-queries.ts` and `ai-queries.ts`:
 * comments are their own resource with their own realtime events, and folding
 * them into `queries.ts` would put a third unrelated domain in a file that is
 * already the shell's.
 */
export const commentKeys = {
  all: ['comments'] as const,
  list: (documentId: string) => ['comments', documentId] as const,
};

export function useComments(
  documentId: string | undefined,
  enabled = true,
): UseQueryResult<CommentListResponse> {
  return useQuery({
    queryKey: commentKeys.list(documentId ?? 'none'),
    queryFn: () => apiRequest<CommentListResponse>(`/api/documents/${documentId ?? ''}/comments`),
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * Keeps the open page's comments in step with everybody else's.
 *
 * All four events invalidate the same key rather than patching the cache by
 * hand: a thread is a list with an order the server decides (open before
 * resolved), and reproducing that ordering in two places is how the panel and
 * the API start disagreeing. A refetch of one page's comments is a small
 * request.
 */
export function useCommentRealtimeSync(documentId: string | null): void {
  const client = useQueryClient();

  const invalidate = React.useCallback(
    (eventDocumentId: string) => {
      if (documentId === null || eventDocumentId !== documentId) return;
      void client.invalidateQueries({ queryKey: commentKeys.list(documentId) });
    },
    [client, documentId],
  );

  useRealtimeEvent('comment.created', (event) => invalidate(event.payload.documentId));
  useRealtimeEvent('comment.updated', (event) => invalidate(event.payload.documentId));
  useRealtimeEvent('comment.resolved', (event) => invalidate(event.payload.documentId));
  useRealtimeEvent('comment.deleted', (event) => invalidate(event.payload.documentId));
}

function useInvalidateComments(documentId: string | undefined) {
  const client = useQueryClient();
  return React.useCallback(() => {
    if (documentId === undefined) return;
    void client.invalidateQueries({ queryKey: commentKeys.list(documentId) });
  }, [client, documentId]);
}

export function useCreateComment(documentId: string | undefined) {
  const invalidate = useInvalidateComments(documentId);
  return useMutation({
    mutationFn: (request: CreateCommentRequest) =>
      apiRequest<CommentResponse>(`/api/documents/${documentId ?? ''}/comments`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateComment(documentId: string | undefined) {
  const invalidate = useInvalidateComments(documentId);
  return useMutation({
    mutationFn: (input: { commentId: string; body: string }) =>
      apiRequest<CommentResponse>(`/api/comments/${input.commentId}`, {
        method: 'PATCH',
        body: { body: input.body },
      }),
    onSuccess: invalidate,
  });
}

export function useResolveComment(documentId: string | undefined) {
  const invalidate = useInvalidateComments(documentId);
  return useMutation({
    mutationFn: (input: { commentId: string; resolved: boolean }) =>
      apiRequest<CommentResponse>(`/api/comments/${input.commentId}/resolve`, {
        method: 'POST',
        body: { resolved: input.resolved },
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteComment(documentId: string | undefined) {
  const invalidate = useInvalidateComments(documentId);
  return useMutation({
    mutationFn: (commentId: string) =>
      apiRequest<DeleteCommentResponse>(`/api/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
