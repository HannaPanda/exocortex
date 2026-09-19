'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  type AddAiConversationSourceRequest,
  AI_RUN_POLL_INTERVAL_MS,
  type AiConversation,
  type AiConversationArchivedFilter,
  type AiConversationDeleteResponse,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type AiConversationSearchResponse,
  type AiConversationSourcesResponse,
  type AiModelListResponse,
  type AiRuleListResponse,
  type AiRuleSummary,
  type AiRun,
  type ConversationToPageRequest,
  type ConversationToPageResponse,
  type CreateAiConversationRequest,
  type DocumentSummary,
  type PostConversationMessageRequest,
  type PostConversationMessageResponse,
  type UpdateAiConversationRequest,
  type UpdateAiConversationSourceRequest,
  type UpdateDocumentRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './queries';

/**
 * Query keys for AI models, conversations and rule pages.
 *
 * Kept in a second file, mirroring `database-queries.ts`: `queries.ts` stays
 * untouched so it does not conflict with the parallel brief queued on it.
 */
export const aiQueryKeys = {
  models: ['ai', 'models'] as const,
  conversations: (workspaceId: string) => ['ai', 'conversations', workspaceId] as const,
  /** The `/chats` archive: one key per filter combination, spanning workspaces. */
  chats: (filters: ChatListFilters) =>
    ['ai', 'chats', filters.workspaceId ?? 'all', filters.archived] as const,
  chatSearch: (query: string, archived: AiConversationArchivedFilter) =>
    ['ai', 'chat-search', query, archived] as const,
  conversation: (conversationId: string) => ['ai', 'conversation', conversationId] as const,
  /** The sources pinned to one conversation, with the sizes the next turn pays (issue #75). */
  conversationSources: (conversationId: string) =>
    ['ai', 'conversation-sources', conversationId] as const,
  aiRules: (workspaceId: string) => ['ai', 'rules', workspaceId] as const,
  run: (runId: string) => ['ai', 'run', runId] as const,
};

/** Run statuses that mean the worker is finished with it, either way. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AiRun['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export function useAiModels(): UseQueryResult<AiModelListResponse> {
  return useQuery({
    queryKey: aiQueryKeys.models,
    queryFn: () => apiRequest<AiModelListResponse>('/api/ai/models'),
    // The registry barely changes; no need to refetch it constantly.
    staleTime: 300_000,
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Reconciles the panel's locally-tracked run against the server's truth
 * (issue #6). The realtime channel is the fast path; this is the safety net
 * for whatever it drops -- a missed `ai.run.completed`, a reconnect, a tab
 * that was backgrounded -- so `activeRunId` can never stay set forever just
 * because a socket event never arrived. Polls only while a run id is given;
 * stops polling itself once the run reaches a terminal status.
 */
export function useAiRun(runId: string | null): UseQueryResult<AiRun> {
  return useQuery({
    queryKey: aiQueryKeys.run(runId ?? 'none'),
    queryFn: () => apiRequest<AiRun>(`/api/ai/runs/${runId ?? ''}`),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined || TERMINAL_RUN_STATUSES.has(status)
        ? false
        : AI_RUN_POLL_INTERVAL_MS;
    },
    // Overrides the app-wide default (off): a run the user is watching must
    // reconcile the moment the tab regains focus, not only every poll tick.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

export function useCancelAiRun() {
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest<AiRun>(`/api/ai/runs/${runId}/cancel`, { method: 'POST' }),
  });
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * The panel's own list: the most recent conversations of one workspace.
 *
 * Short on purpose since issue #69 -- the dropdown shows five and everything
 * beyond that lives in `/chats`, which is what `useChats` below reaches.
 */
export function useAiConversations(workspaceId: string | null): UseQueryResult<AiConversation[]> {
  return useQuery({
    queryKey: aiQueryKeys.conversations(workspaceId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<AiConversationListResponse>(
        `/api/ai/conversations?workspaceId=${encodeURIComponent(workspaceId ?? '')}&limit=${String(PANEL_CONVERSATION_LIMIT)}`,
      );
      return response.conversations;
    },
    enabled: workspaceId !== null,
  });
}

/** How many conversations the panel's dropdown offers before sending the user to `/chats`. */
export const PANEL_CONVERSATION_LIMIT = 5;

export interface ChatListFilters {
  workspaceId: string | null;
  archived: AiConversationArchivedFilter;
}

/**
 * The `/chats` listing: every workspace the person is a member of, paged.
 *
 * `useInfiniteQuery` rather than a page number, because the cursor is the sort
 * key: a conversation touched while the list is open would otherwise shift the
 * page boundary and hide a row.
 */
export function useChats(filters: ChatListFilters) {
  return useInfiniteQuery({
    queryKey: aiQueryKeys.chats(filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ archived: filters.archived });
      if (filters.workspaceId !== null) params.set('workspaceId', filters.workspaceId);
      if (pageParam !== null) params.set('cursor', pageParam);
      return apiRequest<AiConversationListResponse>(`/api/ai/conversations?${params.toString()}`);
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/** Full-text search over the transcripts. Idle until the box holds something. */
export function useChatSearch(
  query: string,
  archived: AiConversationArchivedFilter,
): UseQueryResult<AiConversationSearchResponse> {
  const trimmed = query.trim();
  return useQuery({
    queryKey: aiQueryKeys.chatSearch(trimmed, archived),
    queryFn: () => {
      const params = new URLSearchParams({ q: trimmed, archived });
      return apiRequest<AiConversationSearchResponse>(
        `/api/ai/conversations/search?${params.toString()}`,
      );
    },
    enabled: trimmed.length > 0,
  });
}

/** Irreversible. The caller asks first; this only carries it out. */
export function useDeleteAiConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; workspaceId: string }) =>
      apiRequest<AiConversationDeleteResponse>(
        `/api/ai/conversations/${input.conversationId}/permanent`,
        { method: 'DELETE' },
      ),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: aiQueryKeys.conversations(input.workspaceId) });
      void client.invalidateQueries({ queryKey: ['ai', 'chats'] });
      void client.invalidateQueries({ queryKey: ['ai', 'chat-search'] });
    },
  });
}

/** Saves a transcript as an ordinary page (AP5 of issue #69). */
export function useConversationToPage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; request: ConversationToPageRequest }) =>
      apiRequest<ConversationToPageResponse>(
        `/api/ai/conversations/${input.conversationId}/to-page`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.documentTree(response.workspaceId) });
    },
  });
}

export function useAiConversation(
  conversationId: string | null,
): UseQueryResult<AiConversationDetailResponse> {
  return useQuery({
    queryKey: aiQueryKeys.conversation(conversationId ?? 'none'),
    queryFn: () =>
      apiRequest<AiConversationDetailResponse>(`/api/ai/conversations/${conversationId ?? ''}`),
    enabled: conversationId !== null,
  });
}

export function useCreateAiConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateAiConversationRequest) =>
      apiRequest<{ conversation: AiConversation }>('/api/ai/conversations', {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => {
      void client.invalidateQueries({
        queryKey: aiQueryKeys.conversations(response.conversation.workspaceId),
      });
    },
  });
}

export function useUpdateAiConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; request: UpdateAiConversationRequest }) =>
      apiRequest<{ conversation: AiConversation }>(
        `/api/ai/conversations/${input.conversationId}`,
        {
          method: 'PATCH',
          body: input.request,
        },
      ),
    onSuccess: (response) => {
      void client.invalidateQueries({
        queryKey: aiQueryKeys.conversation(response.conversation.id),
      });
      void client.invalidateQueries({
        queryKey: aiQueryKeys.conversations(response.conversation.workspaceId),
      });
      // A rename or an archive has to reach the `/chats` list too, which is
      // keyed across workspaces and therefore not covered by the key above --
      // and the search results beside it, which are a key of their own and show
      // the same title and the same archived badge.
      void client.invalidateQueries({ queryKey: ['ai', 'chats'] });
      void client.invalidateQueries({ queryKey: ['ai', 'chat-search'] });
    },
  });
}

export function useArchiveAiConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; workspaceId: string }) =>
      apiRequest<{ archived: true }>(`/api/ai/conversations/${input.conversationId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_result, input) => {
      void client.invalidateQueries({ queryKey: aiQueryKeys.conversations(input.workspaceId) });
      void client.invalidateQueries({ queryKey: ['ai', 'chats'] });
      void client.invalidateQueries({ queryKey: ['ai', 'chat-search'] });
    },
  });
}

export function usePostConversationMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; request: PostConversationMessageRequest }) =>
      apiRequest<PostConversationMessageResponse>(
        `/api/ai/conversations/${input.conversationId}/messages`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: (_response, input) => {
      // The user's message (and any command effect) must show up immediately;
      // the assistant reply itself streams in over the realtime channel.
      void client.invalidateQueries({ queryKey: aiQueryKeys.conversation(input.conversationId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Pinned context sources (issue #75, ADR-043)
// ---------------------------------------------------------------------------

export function useConversationSources(
  conversationId: string | null,
): UseQueryResult<AiConversationSourcesResponse> {
  return useQuery({
    queryKey: aiQueryKeys.conversationSources(conversationId ?? 'none'),
    queryFn: () =>
      apiRequest<AiConversationSourcesResponse>(
        `/api/ai/conversations/${conversationId ?? ''}/sources`,
      ),
    enabled: conversationId !== null,
  });
}

/**
 * All three writes answer with the whole list, so the cache is replaced rather
 * than invalidated: the budget is shared, so pinning one source changes the
 * size reported for every other one, and a refetch would show the old numbers
 * for a moment.
 */
function useSourceMutation<TInput extends { conversationId: string }>(
  request: (input: TInput) => Promise<AiConversationSourcesResponse>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (response, input) => {
      client.setQueryData(aiQueryKeys.conversationSources(input.conversationId), response);
    },
  });
}

export function useAddConversationSource() {
  return useSourceMutation(
    (input: { conversationId: string; request: AddAiConversationSourceRequest }) =>
      apiRequest<AiConversationSourcesResponse>(
        `/api/ai/conversations/${input.conversationId}/sources`,
        { method: 'POST', body: input.request },
      ),
  );
}

export function useUpdateConversationSource() {
  return useSourceMutation(
    (input: {
      conversationId: string;
      sourceId: string;
      request: UpdateAiConversationSourceRequest;
    }) =>
      apiRequest<AiConversationSourcesResponse>(
        `/api/ai/conversations/${input.conversationId}/sources/${input.sourceId}`,
        { method: 'PATCH', body: input.request },
      ),
  );
}

export function useRemoveConversationSource() {
  return useSourceMutation((input: { conversationId: string; sourceId: string }) =>
    apiRequest<AiConversationSourcesResponse>(
      `/api/ai/conversations/${input.conversationId}/sources/${input.sourceId}`,
      { method: 'DELETE' },
    ),
  );
}

// ---------------------------------------------------------------------------
// AI rule pages (D5)
// ---------------------------------------------------------------------------

export function useAiRules(workspaceId: string | null): UseQueryResult<AiRuleSummary[]> {
  return useQuery({
    queryKey: aiQueryKeys.aiRules(workspaceId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<AiRuleListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/ai-rules`,
      );
      return response.rules;
    },
    enabled: workspaceId !== null,
  });
}

export function useSetAiRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: UpdateDocumentRequest }) =>
      apiRequest<DocumentSummary>(`/api/documents/${input.documentId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      void client.invalidateQueries({ queryKey: aiQueryKeys.aiRules(document.workspaceId) });
    },
  });
}
