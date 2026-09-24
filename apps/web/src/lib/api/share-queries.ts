'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateShareRequest,
  type IncomingShareListResponse,
  type MyShareListResponse,
  type OutgoingShareListResponse,
  type RevokeShareResponse,
  type ShareListResponse,
  type ShareResponse,
  type UpdateShareRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Page shares and public links (issue #83, ADR-044).
 *
 * Nothing here is cached for long. A share list is the answer to "who can read
 * this", and a stale answer to that question is the one kind of stale answer
 * that is worse than no answer: somebody reads it, believes a link is gone,
 * and moves on.
 */

export const shareKeys = {
  document: (documentId: string) => ['document', documentId, 'shares'] as const,
  /**
   * Deliberately a key without a hook of its own: the move dialog asks this
   * question imperatively, because the answer decides whether the move happens
   * at all (issue #83). A standing query would arrive in a render and need an
   * effect to act on, which is the shape React asks us not to write.
   */
  inherited: (parentId: string) => ['document', parentId, 'inherited-shares'] as const,
  workspace: (workspaceId: string) => ['workspace', workspaceId, 'shares'] as const,
  incoming: () => ['me', 'shares'] as const,
  mine: () => ['me', 'outgoing-shares'] as const,
};

export function useDocumentShares(
  documentId: string | undefined,
  options: { enabled?: boolean } = {},
): UseQueryResult<ShareListResponse> {
  return useQuery({
    queryKey: shareKeys.document(documentId ?? 'none'),
    queryFn: () => apiRequest<ShareListResponse>(`/api/documents/${documentId ?? ''}/shares`),
    enabled: documentId !== undefined && (options.enabled ?? true),
    staleTime: 0,
  });
}

export function useWorkspaceShares(
  workspaceId: string | undefined,
): UseQueryResult<OutgoingShareListResponse> {
  return useQuery({
    queryKey: shareKeys.workspace(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<OutgoingShareListResponse>(`/api/workspaces/${workspaceId ?? ''}/shares`),
    enabled: workspaceId !== undefined,
    staleTime: 0,
  });
}

export function useIncomingShares(): UseQueryResult<IncomingShareListResponse> {
  return useQuery({
    queryKey: shareKeys.incoming(),
    queryFn: () => apiRequest<IncomingShareListResponse>('/api/me/shares'),
    staleTime: 30_000,
  });
}

export function useMyShares(): UseQueryResult<MyShareListResponse> {
  return useQuery({
    queryKey: shareKeys.mine(),
    queryFn: () => apiRequest<MyShareListResponse>('/api/me/outgoing-shares'),
    staleTime: 0,
  });
}

/**
 * Withdrawing from the account-wide list. The row may belong to any
 * workspace, so every per-page and per-workspace list is invalidated with it.
 */
export function useRevokeMyShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      apiRequest<RevokeShareResponse>(`/api/shares/${shareId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.mine() });
      void client.invalidateQueries({ queryKey: ['workspace'] });
      void client.invalidateQueries({ queryKey: ['document'] });
    },
  });
}

export function useCreateShare(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateShareRequest) =>
      apiRequest<ShareResponse>(`/api/documents/${documentId}/shares`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: ['workspace'] });
      void client.invalidateQueries({ queryKey: shareKeys.mine() });
    },
  });
}

export function useUpdateShare(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { shareId: string; request: UpdateShareRequest }) =>
      apiRequest<ShareResponse>(`/api/shares/${input.shareId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: ['workspace'] });
      void client.invalidateQueries({ queryKey: shareKeys.mine() });
    },
  });
}

/**
 * Withdrawing from the workspace-wide list, where the page is a row rather
 * than the thing being looked at. Its own hook because it invalidates a
 * different list: the overview, not one page's dialog.
 */
export function useRevokeWorkspaceShare(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      apiRequest<RevokeShareResponse>(`/api/shares/${shareId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.workspace(workspaceId) });
      void client.invalidateQueries({ queryKey: ['document'] });
      void client.invalidateQueries({ queryKey: shareKeys.mine() });
    },
  });
}

export function useRevokeShare(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      apiRequest<RevokeShareResponse>(`/api/shares/${shareId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: shareKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: ['workspace'] });
      void client.invalidateQueries({ queryKey: shareKeys.mine() });
    },
  });
}
