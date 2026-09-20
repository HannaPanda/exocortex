'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateTemplateRequest,
  type DeleteTemplateResponse,
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type TemplateListResponse,
  type TemplateResponse,
  type UpdateTemplateRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * Page templates (issue #79, ADR-039).
 *
 * A template is addressed by the id of the page it is, so every mutation here
 * takes a `documentId` and there is no template id anywhere in the client.
 */

export const templateKeys = {
  list: (workspaceId: string) => ['workspace', workspaceId, 'templates'] as const,
};

export function useTemplates(
  workspaceId: string | undefined,
): UseQueryResult<TemplateListResponse> {
  return useQuery({
    queryKey: templateKeys.list(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<TemplateListResponse>(`/api/workspaces/${workspaceId ?? ''}/templates`),
    enabled: workspaceId !== undefined,
    staleTime: 60_000,
  });
}

export function useCreateTemplate(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateTemplateRequest) =>
      apiRequest<TemplateResponse>(`/api/workspaces/${workspaceId}/templates`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: templateKeys.list(workspaceId) });
    },
  });
}

export function useUpdateTemplate(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: UpdateTemplateRequest }) =>
      apiRequest<TemplateResponse>(`/api/templates/${input.documentId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: templateKeys.list(workspaceId) });
    },
  });
}

export function useDeleteTemplate(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<DeleteTemplateResponse>(`/api/templates/${documentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: templateKeys.list(workspaceId) });
    },
  });
}

export function useInstantiateTemplate(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: InstantiateTemplateRequest }) =>
      apiRequest<InstantiateTemplateResponse>(`/api/templates/${input.documentId}/pages`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: () => {
      // A new page anywhere in the tree, and the template's usage counter has
      // moved, which is what the picker sorts by.
      void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      void client.invalidateQueries({ queryKey: templateKeys.list(workspaceId) });
    },
  });
}
