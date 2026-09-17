import { describe, expect, it } from 'vitest';

import { type OpenRouterModel, toCatalogEntry } from './ai-models.service';

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
