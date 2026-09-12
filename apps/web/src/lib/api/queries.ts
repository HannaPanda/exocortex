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
  type DeleteDocumentsResponse,
  type DocumentActivityResponse,
  type DocumentDeletionPreviewsResponse,
  type DocumentDetail,
  type DocumentLinksResponse,
  type DocumentSummary,
  type DocumentTreeResponse,
  type GenerateDocumentCoverResponse,
  type MarkdownExportResponse,
  type MarkdownImportResponse,
  type MoveDocumentRequest,
  type RelatedDocumentsResponse,
  type ResolveDocumentLinkResponse,
  type SearchResponse,
  type SetWorkspaceCredentialRequest,
  type TrashResponse,
  type UpdateDocumentRequest,
  type UpdateWorkspaceRequest,
  type UpdateWorkspaceSettingsRequest,
  type UploadAttachmentResponse,
  type Workspace,
  type WorkspaceCredentialListResponse,
  type WorkspaceCredentialPurpose,
  type WorkspaceDetail,
  type WorkspaceListResponse,
  type WorkspaceOverviewResponse,
  type WorkspaceSettingsResponse,
} from '@exocortex/contracts';

import { ApiError, apiRequest } from './client';
import { applyOptimisticMove } from './tree-move';

/** Query keys are centralised so invalidation stays consistent. */
export const queryKeys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  workspaceDetail: (workspaceId: string) => ['workspace', workspaceId, 'detail'] as const,
  documentTree: (workspaceId: string) => ['workspace', workspaceId, 'tree'] as const,
  workspaceOverview: (workspaceId: string) => ['workspace', workspaceId, 'overview'] as const,
  workspaceSettings: (workspaceId: string) => ['workspace', workspaceId, 'settings'] as const,
  workspaceCredentials: (workspaceId: string) => ['workspace', workspaceId, 'credentials'] as const,
  trash: (workspaceId: string) => ['workspace', workspaceId, 'trash'] as const,
  document: (documentId: string) => ['document', documentId] as const,
  search: (workspaceId: string, query: string) =>
    ['workspace', workspaceId, 'search', query] as const,
  documentLinks: (documentId: string) => ['document', documentId, 'links'] as const,
  documentActivity: (documentId: string) => ['document', documentId, 'activity'] as const,
  documentRelated: (documentId: string) => ['document', documentId, 'related'] as const,
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

export function useWorkspaceDetail(
  workspaceId: string | undefined,
): UseQueryResult<WorkspaceDetail> {
  return useQuery({
    queryKey: queryKeys.workspaceDetail(workspaceId ?? 'none'),
    queryFn: () => apiRequest<WorkspaceDetail>(`/api/workspaces/${workspaceId ?? ''}`),
    enabled: workspaceId !== undefined,
  });
}

/**
 * The landing view's read model: recency, databases, sections and what is
 * lying around. Its own request rather than a slice of the tree, because the
 * tree cannot answer any of it -- a body edit never touches the document row.
 */
export function useWorkspaceOverview(
  workspaceId: string | undefined,
): UseQueryResult<WorkspaceOverviewResponse> {
  return useQuery({
    queryKey: queryKeys.workspaceOverview(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<WorkspaceOverviewResponse>(`/api/workspaces/${workspaceId ?? ''}/overview`),
    enabled: workspaceId !== undefined,
    staleTime: 30_000,
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

/**
 * The trash with its shape: what was archived, what came along, and when.
 *
 * Its own query rather than a slice of the tree, because the tree is loaded on
 * every page view and this is read only when somebody opens the trash.
 */
export function useTrash(workspaceId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.trash(workspaceId ?? 'none'),
    queryFn: () => apiRequest<TrashResponse>(`/api/workspaces/${workspaceId ?? ''}/trash`),
    enabled: workspaceId !== undefined && enabled,
  });
}

/**
 * What deleting this selection would take with it. A mutation rather than a
 * query: it is asked once, for one selection, at the moment the dialog opens.
 */
export function useDeletionPreviews(workspaceId: string | undefined) {
  return useMutation({
    mutationFn: (documentIds: string[]) =>
      apiRequest<DocumentDeletionPreviewsResponse>(
        `/api/workspaces/${workspaceId ?? ''}/trash/deletion-preview`,
        { method: 'POST', body: { documentIds } },
      ),
  });
}

/** Deletes archived pages for good. Nothing brings them back. */
export function useDeleteDocuments(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (documentIds: string[]) =>
      apiRequest<DeleteDocumentsResponse>(`/api/workspaces/${workspaceId ?? ''}/trash/delete`, {
        method: 'POST',
        body: { documentIds },
      }),
    onSuccess: (result) => {
      for (const documentId of result.deletedIds) {
        client.removeQueries({ queryKey: queryKeys.document(documentId) });
      }
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.trash(workspaceId) });
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
        // References to the deleted pages are unresolved now, wherever they sit.
        void client.invalidateQueries({ queryKey: queryKeys.pageLinks(workspaceId) });
      }
    },
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
 * Pages that resemble the open one without being linked to it (issue #33).
 *
 * Read in the same panel as the references but kept a separate query: the
 * answer depends on semantic search being on and on the page having been
 * embedded, so it can be slower, be empty for its own reasons, and fail
 * without taking the references down with it. Cached longer than the links
 * because the neighbourhood of a page moves at the pace of the whole
 * workspace, not at the pace of this page's own edits.
 */
export function useRelatedDocuments(documentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.documentRelated(documentId ?? 'none'),
    queryFn: () =>
      apiRequest<RelatedDocumentsResponse>(`/api/documents/${documentId ?? ''}/related`),
    enabled: documentId !== undefined && enabled,
    staleTime: 60_000,
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
    queryFn: () =>
      apiRequest<DocumentActivityResponse>(`/api/documents/${documentId ?? ''}/activity`),
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
  const hasIdentity = typeof reference.documentId === 'string' && reference.documentId.length > 0;
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
    /**
     * The dragged page lands where it was dropped, before the server has said so.
     *
     * The one optimistic update in the app. Everything else can wait a round trip
     * because nothing else is being *held*; a page that jumps back to its old row
     * and then forward again reads as a drag that failed and was retried.
     */
    onMutate: async (variables) => {
      if (workspaceId === undefined) return undefined;
      const key = queryKeys.documentTree(workspaceId);
      // Without this, a tree request already in flight would land afterwards and
      // overwrite the optimistic one with the pre-move order.
      await client.cancelQueries({ queryKey: key });

      const previous = client.getQueryData<DocumentTreeResponse>(key);
      if (previous === undefined) return undefined;

      const next = applyOptimisticMove(previous, variables.documentId, variables.request);
      if (next === null) return undefined;

      client.setQueryData(key, next);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (workspaceId === undefined || context?.previous === undefined) return;
      client.setQueryData(queryKeys.documentTree(workspaceId), context.previous);
    },
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
