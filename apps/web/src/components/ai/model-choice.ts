'use client';

import * as React from 'react';

import {
  type AiConversation,
  type AiModel,
  type AiModelListResponse,
  type AiReasoningLevel,
  aiReasoningLevelSchema,
  clampReasoningLevel,
} from '@exocortex/contracts';

import { usePersistentState } from '@/lib/use-persistent-state';

/**
 * The model and thinking level the user last chose, per workspace.
 *
 * A conversation stores both on its own row, but only once it exists -- and it
 * only exists after the first message. Without this the choice made in an empty
 * panel died on the next reload, and every new conversation started over at the
 * deployment default and `none`. The preference is a browser-local convenience,
 * so `localStorage` is the right home for it: the authoritative value for a
 * conversation that has started is always the one on the row.
 */
export interface ModelPreference {
  /** `null` until something has been chosen; the registry default applies then. */
  modelSlug: string | null;
  reasoningLevel: AiReasoningLevel | null;
  remember: (choice: { modelSlug?: string; reasoningLevel?: AiReasoningLevel }) => void;
}

function parseModelSlug(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
}

function parseReasoningLevel(raw: string): AiReasoningLevel | null {
  const parsed = aiReasoningLevelSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export function useModelPreference(workspaceId: string | null): ModelPreference {
  const scope = workspaceId ?? 'none';
  const [modelSlug, setModelSlug] = usePersistentState<string | null>(
    `exocortex.ai.model.${scope}`,
    null,
    parseModelSlug,
  );
  const [reasoningLevel, setReasoningLevel] = usePersistentState<AiReasoningLevel | null>(
    `exocortex.ai.reasoning.${scope}`,
    null,
    parseReasoningLevel,
  );

  const remember = React.useCallback(
    (choice: { modelSlug?: string; reasoningLevel?: AiReasoningLevel }): void => {
      if (choice.modelSlug !== undefined) setModelSlug(choice.modelSlug);
      if (choice.reasoningLevel !== undefined) setReasoningLevel(choice.reasoningLevel);
    },
    [setModelSlug, setReasoningLevel],
  );

  return { modelSlug, reasoningLevel, remember };
}

/**
 * The model, reasoning level and vision companion this conversation is about to
 * use.
 *
 * The conversation's own choice wins; the remembered preference (made before the
 * first message, when there is no row to write it to yet) comes next; the
 * deployment's default is the floor. The level is clamped the same way the API
 * clamps it, so a remembered `high` never shows on a model that cannot think.
 */
export interface ModelChoice {
  models: AiModel[];
  defaultModelSlug: string | null;
  modelSlug: string | null;
  reasoningLevel: AiReasoningLevel;
  visionCompanionSlug: string | null;
  selectedModel: AiModel | null;
}

export function resolveModelChoice(input: {
  registry: AiModelListResponse | null;
  conversation: AiConversation | null;
  preference: ModelPreference;
}): ModelChoice {
  const models = [...(input.registry?.models ?? [])];
  const defaultModelSlug = input.registry?.defaultModelSlug ?? null;
  const modelSlug = input.conversation?.modelSlug ?? input.preference.modelSlug ?? defaultModelSlug;
  const selectedModel = models.find((model) => model.slug === modelSlug) ?? null;
  const requestedLevel =
    input.conversation?.reasoningLevel ?? input.preference.reasoningLevel ?? 'none';
  return {
    models,
    defaultModelSlug,
    modelSlug,
    reasoningLevel:
      selectedModel === null
        ? requestedLevel
        : clampReasoningLevel(selectedModel.reasoningLevels, requestedLevel),
    visionCompanionSlug: input.conversation?.visionCompanionSlug ?? null,
    selectedModel,
  };
}
