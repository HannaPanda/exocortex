'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateInvitationRequest,
  type Invitation,
  type InvitationListResponse,
  type InvitationWithLink,
  type RevokeInvitationResponse,
  type UpdateWorkspaceMemberRequest,
  type WorkspaceMember,
  type WorkspaceRole,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './queries';

/**
 * Invitations (issue #3), from both sides: the deployment-wide admin list and a
 * single workspace's own.
 *
 * The two share every mutation shape and differ only in their path, so they
 * share a hook with a `scope` rather than being duplicated -- there is one set
 * of invalidation rules to get right instead of two.
 */
export const invitationQueryKeys = {
  admin: ['admin', 'invitations'] as const,
  workspace: (workspaceId: string) => ['workspace', workspaceId, 'invitations'] as const,
};

/** Where the call goes, and therefore which authority it needs. */
export type InvitationScope = { kind: 'admin' } | { kind: 'workspace'; workspaceId: string };

function basePath(scope: InvitationScope): string {
  return scope.kind === 'admin'
    ? '/api/admin/invitations'
    : `/api/workspaces/${scope.workspaceId}/invitations`;
}

function keyFor(scope: InvitationScope) {
  return scope.kind === 'admin'
    ? invitationQueryKeys.admin
    : invitationQueryKeys.workspace(scope.workspaceId);
}

export function useInvitations(
  scope: InvitationScope,
  enabled = true,
): UseQueryResult<Invitation[]> {
  return useQuery({
    queryKey: keyFor(scope),
    enabled,
    queryFn: async () => {
      const response = await apiRequest<InvitationListResponse>(basePath(scope));
      return response.invitations;
    },
  });
}

export function useCreateInvitation(scope: InvitationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateInvitationRequest) =>
      apiRequest<InvitationWithLink>(basePath(scope), { method: 'POST', body: request }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keyFor(scope) });
      // A new invitation shows up in the admin list too, whichever side made it.
      void client.invalidateQueries({ queryKey: invitationQueryKeys.admin });
    },
  });
}

export function useResendInvitation(scope: InvitationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiRequest<InvitationWithLink>(`${basePath(scope)}/${invitationId}/resend`, {
        method: 'POST',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keyFor(scope) }),
  });
}

export function useRevokeInvitation(scope: InvitationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      apiRequest<RevokeInvitationResponse>(`${basePath(scope)}/${invitationId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keyFor(scope) }),
  });
}

/**
 * Changing a member's role.
 *
 * Lives here rather than in `queries.ts` because it belongs to the same screen
 * as the invitation list: the member section of the workspace settings, which is
 * what issue #3 needed a place to put an "Einladen" button on.
 */
export function useUpdateWorkspaceMember(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) =>
      apiRequest<WorkspaceMember>(`/api/workspaces/${workspaceId}/members/${input.userId}`, {
        method: 'PATCH',
        body: { role: input.role } satisfies UpdateWorkspaceMemberRequest,
      }),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetail(workspaceId) }),
  });
}
