import { describe, expect, it } from 'vitest';

import { deriveReasoningLevels, type OpenRouterModel, toCatalogEntry } from './ai-models.service';

describe('deriveReasoningLevels', () => {
  it('believes the efforts the provider reports, including xhigh and max', () => {
    expect(
      deriveReasoningLevels({
        slug: 'openai/gpt-5.6-luna-pro',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
      }),
    ).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']);
  });

  it('drops an effort with no enum value rather than guessing at it', () => {
    expect(
      deriveReasoningLevels({
        slug: 'new/model',
        supportedParameters: ['reasoning_effort'],
        supportedEfforts: ['low', 'ludicrous'],
      }),
    ).toEqual(['NONE', 'LOW']);
  });

  it('always offers NONE, even where the provider does not list it', () => {
    expect(
      deriveReasoningLevels({
        slug: 'new/model',
        supportedParameters: ['reasoning_effort'],
        supportedEfforts: ['high'],
      }),
    ).toEqual(['NONE', 'HIGH']);
  });

  it('falls back to the heuristic when the entry reports no efforts (glm-4.7-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'z-ai/glm-4.7',
        supportedParameters: ['tools', 'response_format', 'reasoning'],
      }),
    ).toEqual(['NONE']);
  });

  it('offers the standard four levels for a non-OpenAI model with reasoning_effort (glm-5.2-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'z-ai/glm-5.2',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
      }),
    ).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
  });

  it('inserts MINIMAL after NONE for an OpenAI model with reasoning_effort (gpt-5.2-like)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'openai/gpt-5.2',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
      }),
    ).toEqual(['NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);
  });

  it('does not add a level for `verbosity` alone (anthropic/claude-sonnet-5-like still needs reasoning_effort)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'anthropic/claude-sonnet-5',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning', 'verbosity'],
      }),
    ).toEqual(['NONE', 'LOW', 'MEDIUM', 'HIGH']);
  });
});

/**
 * The catalogue entry a picked model is created from (issue #67). The provider
 * describes a model in its own vocabulary; this is the translation into the
 * registry's columns, and it is what the admin sees before ticking a box.
 */
describe('toCatalogEntry', () => {
  const entry: OpenRouterModel = {
    id: 'z-ai/glm-5.2',
    name: 'Z.ai: GLM 5.2',
    description: 'Ein Modell.',
    context_length: 200_000,
    architecture: { input_modalities: ['text', 'image'] },
    supported_parameters: ['tools', 'reasoning_effort', 'reasoning'],
    top_provider: { max_completion_tokens: 32_000 },
    pricing: { prompt: '0.0000006', completion: '0.0000022' },
  };

  it('maps the provider fields onto the registry shape', () => {
    expect(toCatalogEntry(entry, false)).toEqual({
      slug: 'z-ai/glm-5.2',
      displayName: 'Z.ai: GLM 5.2',
      description: 'Ein Modell.',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      supportsVision: true,
      supportsTools: true,
      reasoningLevels: ['none', 'low', 'medium', 'high'],
      inputMicroUsdPerMTok: 600_000,
      outputMicroUsdPerMTok: 2_200_000,
      registered: false,
    });
  });

  it('marks what the registry already has, so the row cannot be picked twice', () => {
    expect(toCatalogEntry(entry, true).registered).toBe(true);
  });

  it('falls back to the slug and a conservative context window when the entry is sparse', () => {
    const sparse = toCatalogEntry(
      {
        id: 'tiny/model',
        supported_parameters: [],
        pricing: { prompt: '0', completion: '0' },
      },
      false,
    );

    expect(sparse.displayName).toBe('tiny/model');
    expect(sparse.description).toBeNull();
    expect(sparse.contextWindowTokens).toBe(8192);
    expect(sparse.maxOutputTokens).toBeNull();
    expect(sparse.supportsVision).toBe(false);
    expect(sparse.reasoningLevels).toEqual(['none']);
  });
});
