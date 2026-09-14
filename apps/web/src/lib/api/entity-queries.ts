'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type ConfirmEntityCandidateRequest,
  type ConfirmEntityCandidateResponse,
  type CreateEntityRequest,
  type DismissEntityCandidateResponse,
  type EntityCandidateListResponse,
  type EntityListResponse,
  type EntityMutationResponse,
  type EntityProfile,
  type EntityType,
  type LinkEntityPageRequest,
  type ProvisionEntityDatabaseRequest,
  type ProvisionEntityDatabaseResponse,
  type UpdateEntityRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * The entity layer (issue #47).
 *
 * Deployment-wide rather than per workspace, like the API itself: an entity is
 * a row in the one entity database `entities.databaseId` names, and a profile
 * gathers mentions out of every workspace the caller may read. Hence no
 * `workspaceId` in any key here.
 */

export const entityKeys = {
  list: (query: { q: string; type: EntityType | null }) =>
    ['entities', query.q, query.type ?? 'all'] as const,
  all: ['entities'] as const,
  profile: (entityId: string) => ['entity', entityId] as const,
  candidates: ['entity-candidates'] as const,
};

export function useEntities(query: {
  q: string;
  type: EntityType | null;
}): UseQueryResult<EntityListResponse> {
  return useQuery({
    queryKey: entityKeys.list(query),
    queryFn: () => {
      const params = new URLSearchParams();
      if (query.q.trim().length > 0) params.set('q', query.q.trim());
      if (query.type !== null) params.set('type', query.type);
      const suffix = params.size === 0 ? '' : `?${params.toString()}`;
      return apiRequest<EntityListResponse>(`/api/entities${suffix}`);
    },
  });
}

export function useEntityProfile(entityId: string | null): UseQueryResult<EntityProfile> {
  return useQuery({
    queryKey: entityKeys.profile(entityId ?? 'none'),
    queryFn: () => apiRequest<EntityProfile>(`/api/entities/${entityId ?? ''}`),
    enabled: entityId !== null,
  });
}

export function useEntityCandidates(): UseQueryResult<EntityCandidateListResponse> {
  return useQuery({
    queryKey: entityKeys.candidates,
    queryFn: () => apiRequest<EntityCandidateListResponse>('/api/entities/candidates'),
  });
}

export function useCreateEntity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateEntityRequest) =>
      apiRequest<EntityMutationResponse>('/api/entities', { method: 'POST', body: request }),
    onSuccess: () => void client.invalidateQueries({ queryKey: entityKeys.all }),
  });
}

/**
 * Changes the type or the aliases.
 *
 * Invalidates the profile as well as the list: an alias change queues a rescan,
 * so the mentions a profile shows are about to be different ones.
 */
export function useUpdateEntity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityId: string; request: UpdateEntityRequest }) =>
      apiRequest<EntityMutationResponse>(`/api/entities/${input.entityId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (_response, input) => {
      void client.invalidateQueries({ queryKey: entityKeys.all });
      void client.invalidateQueries({ queryKey: entityKeys.profile(input.entityId) });
    },
  });
}

export function useLinkEntityPage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityId: string; request: LinkEntityPageRequest }) =>
      apiRequest<{ entityId: string; documentId: string; created: boolean }>(
        `/api/entities/${input.entityId}/pages`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: (_response, input) => {
      void client.invalidateQueries({ queryKey: entityKeys.profile(input.entityId) });
      void client.invalidateQueries({ queryKey: entityKeys.all });
    },
  });
}

export function useUnlinkEntityPage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { entityId: string; documentId: string }) =>
      apiRequest<{ entityId: string; documentId: string; removed: boolean }>(
        `/api/entities/${input.entityId}/pages/${input.documentId}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_response, input) => {
      void client.invalidateQueries({ queryKey: entityKeys.profile(input.entityId) });
      void client.invalidateQueries({ queryKey: entityKeys.all });
    },
  });
}

export function useConfirmEntityCandidate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidateId: string; request: ConfirmEntityCandidateRequest }) =>
      apiRequest<ConfirmEntityCandidateResponse>(
        `/api/entities/candidates/${input.candidateId}/confirm`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: entityKeys.candidates });
      void client.invalidateQueries({ queryKey: entityKeys.all });
    },
  });
}

export function useDismissEntityCandidate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string) =>
      apiRequest<DismissEntityCandidateResponse>(
        `/api/entities/candidates/${candidateId}/dismiss`,
        { method: 'POST' },
      ),
    onSuccess: () => void client.invalidateQueries({ queryKey: entityKeys.candidates }),
  });
}

/**
 * Creates the entity database and points the deployment at it.
 *
 * Administrator-only, and done once: `entities.databaseId` decides what every
 * entity call then reads. Without it the list answers with `databaseId: null`
 * and nothing else, which is the state a fresh deployment is in.
 */
export function useProvisionEntityDatabase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ProvisionEntityDatabaseRequest) =>
      apiRequest<ProvisionEntityDatabaseResponse>('/api/entities/database', {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: entityKeys.all }),
  });
}
