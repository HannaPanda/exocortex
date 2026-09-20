'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type SetWorkspaceCredentialRequest,
  type UpdateWorkspaceSettingsRequest,
  type WorkspaceCredentialListResponse,
  type WorkspaceCredentialPurpose,
  type WorkspaceSettingsResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * This workspace's configuration: what is in force, what it set itself, and
 * what it would fall back to (issue #52).
 */
export function useWorkspaceSettings(
  workspaceId: string | undefined,
): UseQueryResult<WorkspaceSettingsResponse> {
  return useQuery({
    queryKey: queryKeys.workspaceSettings(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<WorkspaceSettingsResponse>(`/api/workspaces/${workspaceId ?? ''}/settings`),
    enabled: workspaceId !== undefined,
  });
}

export function useUpdateWorkspaceSettings(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateWorkspaceSettingsRequest) =>
      apiRequest<WorkspaceSettingsResponse>(`/api/workspaces/${workspaceId ?? ''}/settings`, {
        method: 'PATCH',
        body: request,
      }),
    onSuccess: (response) => {
      if (workspaceId === undefined) return;
      // Written straight into the cache rather than invalidated: the response
      // is the resolved answer the form has to redraw from, including the
      // ceilings it may have clamped.
      client.setQueryData(queryKeys.workspaceSettings(workspaceId), response);
    },
  });
}

/**
 * A workspace's own provider keys (issue #52, ADR-023).
 *
 * The response never carries a secret: it says whether one is stored, what it
 * ends in, and when it was last used. Owner-only on the server, so this query
 * is only mounted where that is already known.
 */
export function useWorkspaceCredentials(
  workspaceId: string | undefined,
  enabled: boolean,
): UseQueryResult<WorkspaceCredentialListResponse> {
  return useQuery({
    queryKey: queryKeys.workspaceCredentials(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<WorkspaceCredentialListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/credentials`,
      ),
    enabled: workspaceId !== undefined && enabled,
  });
}

export function useSetWorkspaceCredential(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      purpose: WorkspaceCredentialPurpose;
      request: SetWorkspaceCredentialRequest;
    }) =>
      apiRequest<WorkspaceCredentialListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/credentials/${input.purpose}`,
        { method: 'PUT', body: input.request },
      ),
    onSuccess: (response) => {
      if (workspaceId === undefined) return;
      client.setQueryData(queryKeys.workspaceCredentials(workspaceId), response);
    },
  });
}

export function useRemoveWorkspaceCredential(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (purpose: WorkspaceCredentialPurpose) =>
      apiRequest<WorkspaceCredentialListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/credentials/${purpose}`,
        { method: 'DELETE' },
      ),
    onSuccess: (response) => {
      if (workspaceId === undefined) return;
      client.setQueryData(queryKeys.workspaceCredentials(workspaceId), response);
    },
  });
}
