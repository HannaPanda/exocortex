'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  AI_RUN_POLL_INTERVAL_MS,
  type AiConversation,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type AiModelListResponse,
  type AiRuleListResponse,
  type AiRuleSummary,
  type AiRun,
  type CreateAiConversationRequest,
  type DocumentSummary,
  type PostConversationMessageRequest,
  type PostConversationMessageResponse,
  type UpdateAiConversationRequest,
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
  conversation: (conversationId: string) => ['ai', 'conversation', conversationId] as const,
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

export function useAiConversations(workspaceId: string | null): UseQueryResult<AiConversation[]> {
  return useQuery({
    queryKey: aiQueryKeys.conversations(workspaceId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<AiConversationListResponse>(
        `/api/ai/conversations?workspaceId=${encodeURIComponent(workspaceId ?? '')}`,
      );
      return response.conversations;
    },
    enabled: workspaceId !== null,
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
