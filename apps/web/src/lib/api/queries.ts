'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  type AiRun,
  type CollaborationTicketResponse,
  type CreateDocumentRequest,
  type CurrentSessionResponse,
  type DocumentDetail,
  type DocumentSummary,
  type DocumentTreeResponse,
  type MarkdownExportResponse,
  type MarkdownImportResponse,
  type MoveDocumentRequest,
  type SearchResponse,
  type UpdateDocumentRequest,
  type Workspace,
  type WorkspaceListResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/** Query keys are centralised so invalidation stays consistent. */
export const queryKeys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  documentTree: (workspaceId: string) => ['workspace', workspaceId, 'tree'] as const,
  document: (documentId: string) => ['document', documentId] as const,
  search: (workspaceId: string, query: string) => ['workspace', workspaceId, 'search', query] as const,
  aiRun: (runId: string) => ['ai-run', runId] as const,
};

export function useSessionQuery(): UseQueryResult<CurrentSessionResponse> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiRequest<CurrentSessionResponse>('/api/session'),
    retry: false,
    staleTime: 30_000,
  });
}

export function useWorkspaces(): UseQueryResult<Workspace[]> {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: async () => {
      const response = await apiRequest<WorkspaceListResponse>('/api/workspaces');
      return response.workspaces;
    },
  });
}

export function useDocumentTree(workspaceId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.documentTree(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<DocumentTreeResponse>(`/api/workspaces/${workspaceId ?? ''}/documents/tree`),
    enabled: workspaceId !== undefined,
  });
}

export function useDocument(documentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.document(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentDetail>(`/api/documents/${documentId ?? ''}`),
    enabled: documentId !== undefined,
  });
}

export function useSearch(workspaceId: string | undefined, query: string) {
  return useQuery({
    queryKey: queryKeys.search(workspaceId ?? 'none', query),
    queryFn: () =>
      apiRequest<SearchResponse>(
        `/api/workspaces/${workspaceId ?? ''}/search?q=${encodeURIComponent(query)}`,
      ),
    enabled: workspaceId !== undefined && query.trim().length > 1,
    staleTime: 5_000,
  });
}

export function useCreateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiRequest<Workspace>('/api/workspaces', { method: 'POST', body: { name } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaces });
    },
  });
}

export function useCreateDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateDocumentRequest) =>
      apiRequest<DocumentSummary>(`/api/workspaces/${workspaceId ?? ''}/documents`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useUpdateDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: UpdateDocumentRequest }) =>
      apiRequest<DocumentSummary>(`/api/documents/${input.documentId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useMoveDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: MoveDocumentRequest }) =>
      apiRequest<DocumentSummary>(`/api/documents/${input.documentId}/move`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useArchiveDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<DocumentSummary>(`/api/documents/${documentId}/archive`, { method: 'POST' }),
    onSuccess: (document) => {
      // The open page becomes read-only, so its detail query must refresh too.
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useRestoreDocument(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<DocumentSummary>(`/api/documents/${documentId}/restore`, { method: 'POST' }),
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export function useExportMarkdown() {
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<MarkdownExportResponse>(`/api/documents/${documentId}/export/markdown`),
  });
}

export function useImportMarkdown(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { markdown: string; title?: string; parentId?: string | null }) =>
      apiRequest<MarkdownImportResponse>(`/api/workspaces/${workspaceId ?? ''}/import/markdown`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

export async function fetchCollaborationTicket(
  documentId: string,
): Promise<CollaborationTicketResponse> {
  return apiRequest<CollaborationTicketResponse>(
    `/api/documents/${documentId}/collaboration-ticket`,
    { method: 'POST' },
  );
}

export function useCreateAiRun() {
  return useMutation({
    mutationFn: (input: {
      workspaceId: string;
      documentId: string | null;
      messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
    }) => apiRequest<{ run: AiRun }>('/api/ai/runs', { method: 'POST', body: input }),
  });
}
