'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { type AiRunChangesResponse, type AiRunRevertResponse } from '@exocortex/contracts';

import { aiQueryKeys } from './ai-queries';
import { apiRequest } from './client';
import { queryKeys } from './query-keys';

/** What one AI run changed (issue #248). */
export const runChangesKey = (runId: string) => ['ai', 'run-changes', runId] as const;

/**
 * Which blocks the run changed and where each stands now. Read when somebody
 * asks for it -- the undo dialog, a highlight on the page -- never for every
 * run of a conversation, because answering means deriving the page's states.
 */
export function useAiRunChanges(runId: string | null, enabled = true) {
  return useQuery({
    queryKey: runChangesKey(runId ?? 'none'),
    queryFn: () => apiRequest<AiRunChangesResponse>(`/api/ai/runs/${runId ?? ''}/changes`),
    enabled: enabled && runId !== null,
    // The page moves under the answer whenever somebody types; a reading a
    // minute old is the wrong basis for an undo.
    staleTime: 0,
  });
}

/** Takes the run back block by block; the answer carries the reading afterwards. */
export function useRevertAiRun(conversationId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiRequest<AiRunRevertResponse>(`/api/ai/runs/${runId}/revert`, { method: 'POST' }),
    onSuccess: (response) => {
      client.setQueryData(runChangesKey(response.runId), response.after);
      for (const page of response.restored) {
        void client.invalidateQueries({ queryKey: queryKeys.document(page.documentId) });
      }
      if (conversationId !== null) {
        void client.invalidateQueries({ queryKey: aiQueryKeys.conversation(conversationId) });
      }
    },
  });
}
