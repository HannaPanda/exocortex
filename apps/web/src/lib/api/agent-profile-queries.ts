'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AgentProfileListResponse,
  type AgentProfileResponse,
  type CreateAgentProfileRequest,
  type DeleteAgentProfileResponse,
  type UpdateAgentProfileRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { workItemKeys } from './work-item-queries';

/**
 * Agent profiles (issue #143, ADR-071).
 *
 * A write answers with the whole profile, so the detail cache is written from
 * the answer. The list is invalidated with it, and so are the work items,
 * because which profile is the default, and what budget follows from it, is
 * part of what a work item shows.
 */

export const agentProfileKeys = {
  all: (workspaceId: string) => ['workspace', workspaceId, 'agent-profiles'] as const,
  detail: (profileId: string) => ['agent-profile', profileId] as const,
};

export function useAgentProfiles(workspaceId: string): UseQueryResult<AgentProfileListResponse> {
  return useQuery({
    queryKey: agentProfileKeys.all(workspaceId),
    queryFn: () =>
      apiRequest<AgentProfileListResponse>(`/api/workspaces/${workspaceId}/agent-profiles`),
    staleTime: 60_000,
  });
}

export function useAgentProfile(profileId: string): UseQueryResult<AgentProfileResponse> {
  return useQuery({
    queryKey: agentProfileKeys.detail(profileId),
    queryFn: () => apiRequest<AgentProfileResponse>(`/api/agent-profiles/${profileId}`),
    staleTime: 30_000,
  });
}

function useWriteBack(workspaceId: string) {
  const queryClient = useQueryClient();
  return (response: AgentProfileResponse): void => {
    queryClient.setQueryData(agentProfileKeys.detail(response.profile.id), response);
    void queryClient.invalidateQueries({ queryKey: agentProfileKeys.all(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: workItemKeys.all(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: ['work-item'] });
  };
}

export function useCreateAgentProfile(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (request: CreateAgentProfileRequest) =>
      apiRequest<AgentProfileResponse>(`/api/workspaces/${workspaceId}/agent-profiles`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: writeBack,
  });
}

export function useUpdateAgentProfile(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (input: { profileId: string; request: UpdateAgentProfileRequest }) =>
      apiRequest<AgentProfileResponse>(`/api/agent-profiles/${input.profileId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: writeBack,
  });
}

export function useDuplicateAgentProfile(workspaceId: string) {
  const writeBack = useWriteBack(workspaceId);
  return useMutation({
    mutationFn: (input: { profileId: string; name: string }) =>
      apiRequest<AgentProfileResponse>(`/api/agent-profiles/${input.profileId}/duplicate`, {
        method: 'POST',
        body: { name: input.name },
      }),
    onSuccess: writeBack,
  });
}

export function useDeleteAgentProfile(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      apiRequest<DeleteAgentProfileResponse>(`/api/agent-profiles/${profileId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_response, profileId) => {
      queryClient.removeQueries({ queryKey: agentProfileKeys.detail(profileId) });
      void queryClient.invalidateQueries({ queryKey: agentProfileKeys.all(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: workItemKeys.all(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ['work-item'] });
    },
  });
}
