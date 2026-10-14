'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateExternalMcpServerRequest,
  type DeleteExternalMcpServerResponse,
  type ExternalMcpServer,
  type ExternalMcpServerListResponse,
  type ExternalMcpServerResponse,
  type ExternalMcpToolAccess,
  type SetExternalMcpToolsAccessRequest,
  type UpdateExternalMcpServerRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/**
 * A workspace's external MCP servers (issue #196, ADR-086).
 *
 * Owner-only on the server, so the query is only mounted where that is
 * already known. Every mutation answers with the whole server, which is
 * written into the list rather than refetched: a check is slow, and the
 * answer it brought back is the one the screen has to show.
 */
export function useExternalMcpServers(
  workspaceId: string,
  enabled: boolean,
): UseQueryResult<ExternalMcpServerListResponse> {
  return useQuery({
    queryKey: queryKeys.externalMcpServers(workspaceId),
    queryFn: () =>
      apiRequest<ExternalMcpServerListResponse>(`/api/workspaces/${workspaceId}/mcp-servers`),
    enabled,
  });
}

function useStoreServer(workspaceId: string) {
  const client = useQueryClient();
  return (server: ExternalMcpServer): void => {
    client.setQueryData<ExternalMcpServerListResponse>(
      queryKeys.externalMcpServers(workspaceId),
      (current) => {
        if (current === undefined) return current;
        const known = current.servers.some((entry) => entry.id === server.id);
        return {
          ...current,
          servers: known
            ? current.servers.map((entry) => (entry.id === server.id ? server : entry))
            : [...current.servers, server],
        };
      },
    );
  };
}

export function useCreateExternalMcpServer(workspaceId: string) {
  const store = useStoreServer(workspaceId);
  return useMutation({
    mutationFn: (request: CreateExternalMcpServerRequest) =>
      apiRequest<ExternalMcpServerResponse>(`/api/workspaces/${workspaceId}/mcp-servers`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => store(response.server),
  });
}

export function useUpdateExternalMcpServer(workspaceId: string) {
  const store = useStoreServer(workspaceId);
  return useMutation({
    mutationFn: (input: { serverId: string; request: UpdateExternalMcpServerRequest }) =>
      apiRequest<ExternalMcpServerResponse>(
        `/api/workspaces/${workspaceId}/mcp-servers/${input.serverId}`,
        { method: 'PATCH', body: input.request },
      ),
    onSuccess: (response) => store(response.server),
  });
}

export function useCheckExternalMcpServer(workspaceId: string) {
  const store = useStoreServer(workspaceId);
  return useMutation({
    mutationFn: (serverId: string) =>
      apiRequest<ExternalMcpServerResponse>(
        `/api/workspaces/${workspaceId}/mcp-servers/${serverId}/check`,
        { method: 'POST' },
      ),
    onSuccess: (response) => store(response.server),
  });
}

export function useSetExternalMcpToolAccess(workspaceId: string) {
  const store = useStoreServer(workspaceId);
  return useMutation({
    mutationFn: (input: { serverId: string; toolId: string; access: ExternalMcpToolAccess }) =>
      apiRequest<ExternalMcpServerResponse>(
        `/api/workspaces/${workspaceId}/mcp-servers/${input.serverId}/tools/${input.toolId}`,
        { method: 'PATCH', body: { access: input.access } },
      ),
    onSuccess: (response) => store(response.server),
  });
}

/** Several decisions at once: applying the suggestions a person looked at. */
export function useSetExternalMcpToolsAccess(workspaceId: string) {
  const store = useStoreServer(workspaceId);
  return useMutation({
    mutationFn: (input: { serverId: string; request: SetExternalMcpToolsAccessRequest }) =>
      apiRequest<ExternalMcpServerResponse>(
        `/api/workspaces/${workspaceId}/mcp-servers/${input.serverId}/tools`,
        { method: 'PATCH', body: input.request },
      ),
    onSuccess: (response) => store(response.server),
  });
}

export function useRemoveExternalMcpServer(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (serverId: string) =>
      apiRequest<DeleteExternalMcpServerResponse>(
        `/api/workspaces/${workspaceId}/mcp-servers/${serverId}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_response, serverId) => {
      client.setQueryData<ExternalMcpServerListResponse>(
        queryKeys.externalMcpServers(workspaceId),
        (current) =>
          current === undefined
            ? current
            : { ...current, servers: current.servers.filter((entry) => entry.id !== serverId) },
      );
    },
  });
}
