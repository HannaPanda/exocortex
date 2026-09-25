'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AddAiConversationSourceRequest,
  type AiConversationSource,
  type AiConversationSourceMode,
  type AiConversationSourcesResponse,
} from '@exocortex/contracts';

import {
  useAddConversationSource,
  useConversationSources,
  useRemoveConversationSource,
  useUpdateConversationSource,
} from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';

export interface PinnedSources {
  /** The list and the shared budget, or `null` before a conversation exists. */
  pinned: AiConversationSourcesResponse | null;
  add: (request: AddAiConversationSourceRequest) => void;
  setMode: (source: AiConversationSource, mode: AiConversationSourceMode) => void;
  remove: (source: AiConversationSource) => void;
}

/**
 * The chip row's half of the pinned sources (issue #75).
 *
 * `ensureConversation` is what makes the plus usable on an empty panel:
 * pinning needs a conversation row to hang off, and a chip row that promises
 * "this stays until you take it away" cannot live in component state. So the
 * first pin starts the conversation exactly as a first message would.
 */
export function usePinnedSources(input: {
  conversationId: string | null;
  ensureConversation: () => Promise<string>;
  onError: (message: string) => void;
}): PinnedSources {
  const { conversationId, ensureConversation, onError } = input;
  const t = useTranslations('ai.context');
  const sourcesQuery = useConversationSources(conversationId);
  const addSource = useAddConversationSource();
  const updateSource = useUpdateConversationSource();
  const removeSource = useRemoveConversationSource();

  const add = React.useCallback(
    (request: AddAiConversationSourceRequest): void => {
      void (async () => {
        const id = conversationId ?? (await ensureConversation());
        await addSource.mutateAsync({ conversationId: id, request });
      })().catch((caught: unknown) => {
        onError(caught instanceof ApiError ? caught.message : t('pinFailed'));
      });
    },
    [addSource, conversationId, ensureConversation, onError, t],
  );

  const setMode = React.useCallback(
    (source: AiConversationSource, mode: AiConversationSourceMode): void => {
      if (conversationId === null) return;
      void updateSource.mutateAsync({ conversationId, sourceId: source.id, request: { mode } });
    },
    [conversationId, updateSource],
  );

  const remove = React.useCallback(
    (source: AiConversationSource): void => {
      if (conversationId === null) return;
      void removeSource.mutateAsync({ conversationId, sourceId: source.id });
    },
    [conversationId, removeSource],
  );

  return { pinned: sourcesQuery.data ?? null, add, setMode, remove };
}
