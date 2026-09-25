'use client';

import * as React from 'react';

import { type AiConversation, type AiReasoningLevel } from '@exocortex/contracts';

import { useUpdateAiConversation } from '@/lib/api/ai-queries';

import { type ModelPreference } from './model-choice';

/**
 * The settings of the open conversation that the panel lets a person change:
 * model, thinking level, vision companion and page context.
 *
 * Each of them is operable before the first message, when there is no
 * conversation row to write to yet, and each deals with that differently --
 * which is the reason they sit together (split out of `ai-panel.tsx`,
 * issue #97).
 */
export function useConversationSettings({
  conversationId,
  conversation,
  preference,
}: {
  conversationId: string | null;
  conversation: AiConversation | null;
  preference: ModelPreference;
}) {
  const updateConversation = useUpdateAiConversation();
  // Same problem as the model choice, without the memory: the chip is operable
  // before the first message, when there is no conversation row to write it to.
  // It travels along in the create request and is deliberately not remembered,
  // because page context is a decision about one conversation.
  const [pendingPageContextEnabled, setPendingPageContextEnabled] = React.useState<boolean | null>(
    null,
  );

  const pageContextEnabled = conversation?.pageContextEnabled ?? pendingPageContextEnabled ?? true;

  const update = (request: Parameters<typeof updateConversation.mutateAsync>[0]['request']) => {
    if (conversationId === null) return;
    void updateConversation.mutateAsync({ conversationId, request });
  };

  // Model and thinking level are remembered per workspace as well, so they
  // also seed every following conversation.
  const changeModel = (slug: string): void => {
    preference.remember({ modelSlug: slug });
    update({ modelSlug: slug });
  };

  const changeReasoningLevel = (level: AiReasoningLevel): void => {
    preference.remember({ reasoningLevel: level });
    update({ reasoningLevel: level });
  };

  const changePageContext = (enabled: boolean): void => {
    if (conversationId === null) {
      setPendingPageContextEnabled(enabled);
      return;
    }
    update({ pageContextEnabled: enabled });
  };

  // The create request has no field for it; the control is disabled until a
  // conversation exists (ModelPicker enforces this via `visionCompanionEditable`).
  const changeVisionCompanion = (value: string | null): void => {
    update({ visionCompanionSlug: value });
  };

  /** Called once a created conversation has taken the pending choice along. */
  const clearPendingPageContext = React.useCallback(
    (): void => setPendingPageContextEnabled(null),
    [],
  );

  return {
    pageContextEnabled,
    pendingPageContextEnabled,
    clearPendingPageContext,
    changeModel,
    changeReasoningLevel,
    changePageContext,
    changeVisionCompanion,
  };
}
