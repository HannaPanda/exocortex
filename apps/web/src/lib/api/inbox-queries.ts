'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CaptureRequest,
  type CaptureResponse,
  type InboxResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './queries';

/**
 * The inbox and the capture that fills it (issue #71, ADR-036).
 *
 * Its own file for the same reason `placement-queries.ts` is: capture is the
 * one write in the app that is not made from an open page, so it belongs to the
 * shell rather than to a document.
 */

export const inboxKeys = {
  inbox: (workspaceId: string) => ['workspace', workspaceId, 'inbox'] as const,
};

export function useInbox(workspaceId: string | undefined): UseQueryResult<InboxResponse> {
  return useQuery({
    queryKey: inboxKeys.inbox(workspaceId ?? 'none'),
    queryFn: () => apiRequest<InboxResponse>(`/api/workspaces/${workspaceId ?? ''}/inbox`),
    enabled: workspaceId !== undefined,
    staleTime: 30_000,
  });
}

export function useCapture(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CaptureRequest) =>
      apiRequest<CaptureResponse>(`/api/workspaces/${workspaceId ?? ''}/capture`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      // The tree gains a page, and on the first capture a whole new top-level
      // one, so the navigation has to be re-read rather than patched.
      void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      void client.invalidateQueries({ queryKey: inboxKeys.inbox(workspaceId) });
    },
  });
}
