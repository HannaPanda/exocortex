import { describe, expect, it } from 'vitest';

import {
  deriveReasoningLevels,
  type OpenRouterModel,
  toCatalogEntry,
  worstCaseFromEndpoints,
} from './ai-models.service';

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
      aliasTargetSlug: null,
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

  it('describes an alias with the figures of the model it resolves to', () => {
    const alias: OpenRouterModel = {
      id: '~z-ai/glm-latest',
      name: 'Z.ai: GLM Latest',
      description: 'Always the latest GLM.',
      alias_target: { slug: 'z-ai/glm-5.2' },
      // The alias row carries the *cheapest* endpoint's numbers, which is
      // exactly what must not end up in the registry.
      context_length: 262_144,
      supported_parameters: ['tools', 'reasoning_effort'],
      pricing: { prompt: '0.0000008775', completion: '0.00000297' },
    };

    expect(toCatalogEntry(alias, false, entry)).toMatchObject({
      slug: '~z-ai/glm-latest',
      displayName: 'Z.ai: GLM Latest',
      aliasTargetSlug: 'z-ai/glm-5.2',
      contextWindowTokens: 200_000,
      inputMicroUsdPerMTok: 600_000,
    });
  });

  it('leaves an ordinary entry without an alias target', () => {
    expect(toCatalogEntry(entry, false).aliasTargetSlug).toBeNull();
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

/**
 * One model, many providers, one row (issue #67). The router picks an endpoint
 * per request, so the registry's single number has to be the pessimistic one:
 * compaction that triggers early beats a refusal, and a cost estimate that is
 * too high beats one that is too low.
 */
describe('worstCaseFromEndpoints', () => {
  const endpoints = [
    {
      context_length: 1_048_576,
      max_completion_tokens: 943_718,
      pricing: { prompt: '0.0000014', completion: '0.0000044' },
    },
    {
      context_length: 262_144,
      max_completion_tokens: 235_929,
      pricing: { prompt: '0.0000008775', completion: '0.00000297' },
    },
  ];

  it('takes the smallest window and the highest price', () => {
    expect(worstCaseFromEndpoints(endpoints)).toEqual({
      contextWindowTokens: 262_144,
      maxOutputTokens: 235_929,
      inputMicroUsdPerMTok: 1_400_000,
      outputMicroUsdPerMTok: 4_400_000,
    });
  });

  it('answers null when there is nothing to read', () => {
    expect(worstCaseFromEndpoints([])).toBeNull();
    expect(worstCaseFromEndpoints([{ pricing: { prompt: '0.1', completion: '0.2' } }])).toBeNull();
  });

  it('keeps maxOutputTokens null when no endpoint states one', () => {
    expect(
      worstCaseFromEndpoints([
        {
          context_length: 1000,
          max_completion_tokens: null,
          pricing: { prompt: '0', completion: '0' },
        },
      ])?.maxOutputTokens,
    ).toBeNull();
  });
});
