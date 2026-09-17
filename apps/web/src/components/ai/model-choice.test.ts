import { describe, expect, it } from 'vitest';

import {
  type AiConversation,
  type AiModel,
  type AiModelListResponse,
  type AiReasoningLevel,
} from '@exocortex/contracts';

import { resolveModelChoice } from './model-choice';

/**
 * Which model answers and how hard it thinks (issue #67).
 *
 * Three sources disagree on purpose: the conversation row, the preference
 * remembered in this browser, and the registry default. These tests pin the
 * order between them, and the clamping that keeps a remembered `high` from
 * showing on a model that cannot think.
 */
function model(
  slug: string,
  reasoningLevels: AiReasoningLevel[] = ['none', 'low', 'high'],
): AiModel {
  return {
    id: `id-${slug}`,
    slug,
    provider: 'openrouter',
    displayName: slug,
    description: null,
    contextWindowTokens: 200_000,
    maxOutputTokens: 8000,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels,
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 2_000_000,
    visionCompanionSlug: null,
    aliasTargetSlug: null,
    enabled: true,
    sortOrder: 100,
    syncedAt: null,
  };
}

function registry(models: AiModel[], defaultModelSlug: string | null): AiModelListResponse {
  return { models, defaultModelSlug };
}

function conversation(input: Partial<AiConversation>): AiConversation {
  return {
    id: 'conv-1',
    workspaceId: 'ws-1',
    title: 'Test',
    documentId: null,
    documentTitle: null,
    preview: '',
    pageContextEnabled: true,
    modelSlug: null,
    reasoningLevel: 'none',
    visionCompanionSlug: null,
    estimatedTokens: 0,
    lastMessageAt: '2026-09-16T10:00:00.000Z',
    createdAt: '2026-09-16T10:00:00.000Z',
    createdById: 'user-1',
    contextUsagePercent: 0,
    messageCount: 2,
    archivedAt: null,
    ...input,
  };
}

const NO_PREFERENCE = { modelSlug: null, reasoningLevel: null, remember: () => {} };

describe('resolveModelChoice', () => {
  it('falls back to the registry default when nothing has been chosen', () => {
    const choice = resolveModelChoice({
      registry: registry([model('a/one'), model('b/two')], 'b/two'),
      conversation: null,
      preference: NO_PREFERENCE,
    });

    expect(choice.modelSlug).toBe('b/two');
    expect(choice.reasoningLevel).toBe('none');
  });

  it('starts a conversation-less panel from the remembered preference', () => {
    const choice = resolveModelChoice({
      registry: registry([model('a/one'), model('b/two')], 'b/two'),
      conversation: null,
      preference: { modelSlug: 'a/one', reasoningLevel: 'high', remember: () => {} },
    });

    expect(choice.modelSlug).toBe('a/one');
    expect(choice.reasoningLevel).toBe('high');
  });

  it("lets a started conversation's own choice win over the preference", () => {
    const choice = resolveModelChoice({
      registry: registry([model('a/one'), model('b/two')], 'a/one'),
      conversation: conversation({ modelSlug: 'b/two', reasoningLevel: 'low' }),
      preference: { modelSlug: 'a/one', reasoningLevel: 'high', remember: () => {} },
    });

    expect(choice.modelSlug).toBe('b/two');
    expect(choice.reasoningLevel).toBe('low');
  });

  it('clamps a remembered level the selected model does not offer', () => {
    const choice = resolveModelChoice({
      registry: registry([model('a/one', ['none'])], 'a/one'),
      conversation: null,
      preference: { modelSlug: 'a/one', reasoningLevel: 'high', remember: () => {} },
    });

    expect(choice.reasoningLevel).toBe('none');
  });

  it('keeps the requested level while the registry is still loading', () => {
    const choice = resolveModelChoice({
      registry: null,
      conversation: null,
      preference: { modelSlug: 'a/one', reasoningLevel: 'high', remember: () => {} },
    });

    expect(choice.selectedModel).toBeNull();
    expect(choice.reasoningLevel).toBe('high');
  });
});
