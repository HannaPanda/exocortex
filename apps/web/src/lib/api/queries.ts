'use client';

import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  type AiRun,
  type ApiErrorResponse,
  type CollaborationTicketResponse,
  type CreateDocumentRequest,
  type CurrentSessionResponse,
  type DocumentActivityResponse,
  type DocumentDetail,
  type DocumentLinksResponse,
  type DocumentSummary,
  type DocumentTreeResponse,
  type GenerateDocumentCoverResponse,
  type MarkdownExportResponse,
  type MarkdownImportResponse,
  type MoveDocumentRequest,
  type ResolveDocumentLinkResponse,
  type SearchResponse,
  type UpdateDocumentRequest,
  type UpdateWorkspaceRequest,
  type UploadAttachmentResponse,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceListResponse,
} from '@exocortex/contracts';

import { ApiError, apiRequest } from './client';

/** Query keys are centralised so invalidation stays consistent. */
export const queryKeys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  workspaceDetail: (workspaceId: string) => ['workspace', workspaceId, 'detail'] as const,
  documentTree: (workspaceId: string) => ['workspace', workspaceId, 'tree'] as const,
  document: (documentId: string) => ['document', documentId] as const,
  search: (workspaceId: string, query: string) => ['workspace', workspaceId, 'search', query] as const,
  documentLinks: (documentId: string) => ['document', documentId, 'links'] as const,
  documentActivity: (documentId: string) => ['document', documentId, 'activity'] as const,
  /** Every resolved reference of a workspace; the prefix all of them share. */
  pageLinks: (workspaceId: string) => ['workspace', workspaceId, 'page-link'] as const,
  pageLink: (workspaceId: string, reference: { documentId?: string | null; title?: string }) =>
    [
      'workspace',
      workspaceId,
      'page-link',
      reference.documentId ?? '',
      (reference.title ?? '').toLowerCase(),
    ] as const,
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

export function useWorkspaceDetail(workspaceId: string | undefined): UseQueryResult<WorkspaceDetail> {
  return useQuery({
    queryKey: queryKeys.workspaceDetail(workspaceId ?? 'none'),
    queryFn: () => apiRequest<WorkspaceDetail>(`/api/workspaces/${workspaceId ?? ''}`),
    enabled: workspaceId !== undefined,
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

/**
 * The reference index of a page: who points at it, and what it points at.
 *
 * Kept out of `useDocument` on purpose — it is a second table, it is only read
 * when the Verweise tab is open, and it is refreshed by materialization rather
 * than by the request that changed the page.
 */
export function useDocumentLinks(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentLinks(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentLinksResponse>(`/api/documents/${documentId ?? ''}/links`),
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * The "Aktivität" tab: the page's own history, merged server-side from
 * snapshots, the audit log and the document row (issue #20). Kept out of
 * `useDocument` for the same reason `useDocumentLinks` is: a second table,
 * only read while that tab is open.
 */
export function useDocumentActivity(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentActivity(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentActivityResponse>(`/api/documents/${documentId ?? ''}/activity`),
    enabled: documentId !== undefined && enabled,
    staleTime: 10_000,
  });
}

/**
 * Restores a page to an earlier snapshot. Destructive (the current state is
 * itself snapshotted first as a safety net, but the visible content changes
 * immediately and reaches an open editing session), so the caller is expected
 * to confirm before calling this.
 */
export function useRestoreSnapshot(documentId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (snapshotId: string) =>
      apiRequest<{ documentId: string; restoredFrom: string }>(
        `/api/documents/${documentId ?? ''}/snapshots/${snapshotId}/restore`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      if (documentId === undefined) return;
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId) });
      void client.invalidateQueries({ queryKey: queryKeys.documentActivity(documentId) });
    },
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

/** What a reference to another page carries: an identity, a title, or both. */
export interface PageLinkReference {
  /** `pageLink`'s `documentId`. Absent for a `[[Titel]]` mark or a page mention. */
  documentId?: string | null;
  /** The stored display title. */
  title?: string;
}

/**
 * Resolves a reference to another page to the document(s) it means.
 *
 * Shared by the click path (`link-navigation.tsx`, via `queryClient.fetchQuery`)
 * and the `pageLink` block's own node view (`usePageLinkResolution` below), so
 * both read from the same cache entry per reference. The identity is part of
 * the cache key, because two links with the same label may well mean two
 * different pages (issue #14).
 */
export function pageLinkQueryOptions(workspaceId: string, reference: PageLinkReference) {
  const query = new URLSearchParams();
  if (typeof reference.title === 'string' && reference.title.length > 0) {
    query.set('title', reference.title);
  }
  if (typeof reference.documentId === 'string' && reference.documentId.length > 0) {
    query.set('documentId', reference.documentId);
  }
  return {
    queryKey: queryKeys.pageLink(workspaceId, reference),
    queryFn: () =>
      apiRequest<ResolveDocumentLinkResponse>(
        `/api/workspaces/${workspaceId}/documents/resolve?${query.toString()}`,
      ),
    staleTime: 30_000,
  };
}

/** For the page-link block, which shows its resolution state before anyone clicks it. */
export function usePageLinkResolution(
  workspaceId: string,
  reference: PageLinkReference,
): UseQueryResult<ResolveDocumentLinkResponse> {
  const hasTitle = typeof reference.title === 'string' && reference.title.length > 0;
  const hasIdentity =
    typeof reference.documentId === 'string' && reference.documentId.length > 0;
  return useQuery({
    ...pageLinkQueryOptions(workspaceId, reference),
    enabled: hasTitle || hasIdentity,
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

export function useUpdateWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { workspaceId: string; request: UpdateWorkspaceRequest }) =>
      apiRequest<Workspace>(`/api/workspaces/${input.workspaceId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (_workspace, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.workspaces });
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetail(variables.workspaceId) });
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

/**
 * Uploads a cover image and makes it the page's cover in one request.
 *
 * `fetch` rather than `apiRequest`, for the same reason `uploadAttachment` uses
 * it: the body is `FormData` and the browser has to set the multipart boundary
 * itself, which it only does when no content type is given.
 */
export function useUploadDocumentCover(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { documentId: string; file: File }) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);

      const response = await fetch(`/api/documents/${input.documentId}/cover`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        body: form,
      });

      const text = await response.text();
      const payload: unknown = text.length > 0 ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new ApiError(response.status, payload as Partial<ApiErrorResponse> | null);
      }
      return payload as DocumentSummary;
    },
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

/**
 * Asks the AI to draw the page's cover.
 *
 * Resolves as soon as the job is queued, not when the picture exists. Nothing
 * is invalidated here on purpose: the finished cover arrives as a
 * `document.updated` event, and the outcome as `document.cover.generated`.
 */
export function useGenerateDocumentCover() {
  return useMutation({
    mutationFn: (input: { documentId: string; prompt: string }) =>
      apiRequest<GenerateDocumentCoverResponse>(
        `/api/documents/${input.documentId}/cover/generate`,
        { method: 'POST', body: { prompt: input.prompt } },
      ),
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
    onSuccess: (_document, variables) => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
      // A move across workspaces empties the current tree and fills a
      // different one; that target workspace's own tree query needs the same
      // invalidation, whether or not anyone has it open right now.
      const targetWorkspaceId = variables.request.workspaceId;
      if (targetWorkspaceId !== undefined && targetWorkspaceId !== workspaceId) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(targetWorkspaceId) });
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
      invalidateParentDetail(client, document.parentId);
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
      invalidateParentDetail(client, document.parentId);
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

/**
 * Refreshes the parent's detail after a child appeared or disappeared.
 *
 * A database's detail carries `rowCount`, and its rows are ordinary child
 * documents (ADR-011), so archiving or restoring one changes a number that is
 * cached against the *parent*. The parent of a plain page has nothing that
 * depends on its children, which makes this a cheap no-op there rather than a
 * special case worth branching on.
 */
function invalidateParentDetail(client: QueryClient, parentId: string | null): void {
  if (parentId === null) return;
  void client.invalidateQueries({ queryKey: queryKeys.document(parentId) });
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

/**
 * Uploads a file and returns the **stable** URL to reference it from a document.
 *
 * Not the `downloadUrl` the endpoint also returns: that is a presigned storage URL
 * that expires after five minutes, and a document lives longer than that. The API
 * route below checks the session on every request, so an attachment stays as
 * private as the page it sits on.
 */
export async function uploadAttachment(input: {
  workspaceId: string;
  documentId: string;
  file: File;
}): Promise<{ src: string; name: string }> {
  const form = new FormData();
  form.append('documentId', input.documentId);
  form.append('file', input.file, input.file.name);

  const response = await fetch(`/api/workspaces/${input.workspaceId}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
    body: form,
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(response.status, payload as Partial<ApiErrorResponse> | null);
  }

  const { attachment } = payload as UploadAttachmentResponse;
  return {
    src: `/api/attachments/${attachment.id}/download`,
    name: attachment.filename,
  };
}
