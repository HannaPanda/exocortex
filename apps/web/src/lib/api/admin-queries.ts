'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AdminOverviewResponse,
  type AdminUser,
  type AdminUserListResponse,
  type AiModel,
  type AiModelListResponse,
  type ApiToken,
  type ApiTokenListResponse,
  type ConnectedApp,
  type ConnectedAppListResponse,
  type CreateAiModelRequest,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type DeleteUserResponse,
  type DisconnectAppResponse,
  type SettingsResponse,
  type SyncAiModelsRequest,
  type SyncAiModelsResponse,
  type UpdateAiModelRequest,
  type UpdateSettingsRequest,
  type UpdateUserRoleRequest,
  type UpdateUserStatusRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Query keys for the admin area and personal API tokens.
 *
 * Kept in a second file, mirroring `database-queries.ts`: `queries.ts` stays
 * untouched so it does not conflict with the parallel brief queued on it.
 */
export const adminQueryKeys = {
  overview: ['admin', 'overview'] as const,
  settings: ['admin', 'settings'] as const,
  users: ['admin', 'users'] as const,
  aiModels: ['admin', 'ai-models'] as const,
  apiTokens: ['me', 'api-tokens'] as const,
  connections: ['me', 'connections'] as const,
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function useAdminOverview(): UseQueryResult<AdminOverviewResponse> {
  return useQuery({
    queryKey: adminQueryKeys.overview,
    queryFn: () => apiRequest<AdminOverviewResponse>('/api/admin/overview'),
    // A forbidden/admin_required response never resolves on retry, and
    // AdminGuard uses this same query to decide access, so it should fail fast.
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The whole response, not just `settings`: `invalidKeys` names the stored rows
 * the deployment had to ignore, and the form has to say so (issue #27).
 */
export function useAdminSettings(): UseQueryResult<SettingsResponse> {
  return useQuery({
    queryKey: adminQueryKeys.settings,
    queryFn: () => apiRequest<SettingsResponse>('/api/admin/settings'),
  });
}

export function useUpdateAdminSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateSettingsRequest) =>
      apiRequest<SettingsResponse>('/api/admin/settings', { method: 'PATCH', body: request }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminQueryKeys.settings });
      void client.invalidateQueries({ queryKey: adminQueryKeys.overview });
    },
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function useAdminUsers(): UseQueryResult<AdminUser[]> {
  return useQuery({
    queryKey: adminQueryKeys.users,
    queryFn: async () => {
      const response = await apiRequest<AdminUserListResponse>('/api/admin/users');
      return response.users;
    },
  });
}

export function useUpdateUserRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; request: UpdateUserRoleRequest }) =>
      apiRequest<AdminUser>(`/api/admin/users/${input.userId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminQueryKeys.users });
      void client.invalidateQueries({ queryKey: adminQueryKeys.overview });
    },
  });
}

/** Switching an account off or back on. Separate route, separate mutation. */
export function useUpdateUserStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; disabled: boolean }) =>
      apiRequest<AdminUser>(`/api/admin/users/${input.userId}/status`, {
        method: 'PATCH',
        body: { disabled: input.disabled } satisfies UpdateUserStatusRequest,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminQueryKeys.users });
      void client.invalidateQueries({ queryKey: adminQueryKeys.overview });
    },
  });
}

export function useDeleteUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiRequest<DeleteUserResponse>(`/api/admin/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: adminQueryKeys.users });
      void client.invalidateQueries({ queryKey: adminQueryKeys.overview });
    },
  });
}

// ---------------------------------------------------------------------------
// AI model registry
// ---------------------------------------------------------------------------

export function useAdminAiModels(): UseQueryResult<AiModelListResponse> {
  return useQuery({
    queryKey: adminQueryKeys.aiModels,
    queryFn: () => apiRequest<AiModelListResponse>('/api/admin/ai-models'),
  });
}

export function useCreateAiModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateAiModelRequest) =>
      apiRequest<AiModel>('/api/admin/ai-models', { method: 'POST', body: request }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.aiModels }),
  });
}

export function useUpdateAiModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { modelId: string; request: UpdateAiModelRequest }) =>
      apiRequest<AiModel>(`/api/admin/ai-models/${input.modelId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.aiModels }),
  });
}

export function useDeleteAiModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) =>
      apiRequest<{ deleted: boolean; disabled: boolean }>(`/api/admin/ai-models/${modelId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.aiModels }),
  });
}

export function useSyncAiModels() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: SyncAiModelsRequest) =>
      apiRequest<SyncAiModelsResponse>('/api/admin/ai-models/sync', {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.aiModels }),
  });
}

// ---------------------------------------------------------------------------
// Personal API tokens (not admin-only: every signed-in user manages their own)
// ---------------------------------------------------------------------------

export function useApiTokens(): UseQueryResult<ApiToken[]> {
  return useQuery({
    queryKey: adminQueryKeys.apiTokens,
    queryFn: async () => {
      const response = await apiRequest<ApiTokenListResponse>('/api/me/api-tokens');
      return response.tokens;
    },
  });
}

export function useCreateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateApiTokenRequest) =>
      apiRequest<CreateApiTokenResponse>('/api/me/api-tokens', { method: 'POST', body: request }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.apiTokens }),
  });
}

export function useRevokeApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiRequest<{ revoked: true }>(`/api/me/api-tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.apiTokens }),
  });
}

// ---------------------------------------------------------------------------
// Connected OAuth applications (the caller's own, same as the tokens above)
// ---------------------------------------------------------------------------

export function useConnectedApps(): UseQueryResult<ConnectedApp[]> {
  return useQuery({
    queryKey: adminQueryKeys.connections,
    queryFn: async () => {
      const response = await apiRequest<ConnectedAppListResponse>('/api/me/connections');
      return response.applications;
    },
  });
}

export function useDisconnectApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (clientId: string) =>
      apiRequest<DisconnectAppResponse>(`/api/me/connections/${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: adminQueryKeys.connections }),
  });
}
