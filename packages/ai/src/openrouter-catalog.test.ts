import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveReasoningLevels,
  fetchOpenRouterModels,
  mapEndpoint,
  mapModelFields,
  modelFieldsFromEndpoints,
  type OpenRouterEndpoint,
  type OpenRouterEndpointSnapshot,
} from './openrouter-catalog';

/**
 * Reading OpenRouter's catalogue (issue #68, ADR-032).
 *
 * The fixtures are the shapes the live API actually returns, including the two
 * traps: an alias row describes the cheapest endpoint rather than the model, and
 * the routing key is `tag`, never the display name.
 */
describe('deriveReasoningLevels', () => {
  it('believes the efforts the provider reports, including xhigh and max', () => {
    expect(
      deriveReasoningLevels({
        slug: 'openai/gpt-5.6-luna-pro',
        supportedParameters: ['tools', 'reasoning_effort'],
        supportedEfforts: ['max', 'xhigh', 'high', 'medium', 'low', 'none'],
      }),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('offers no "do not think" for a model whose reasoning is mandatory', () => {
    // As OpenRouter reported google/gemini-3.5-flash on 2026-10-14; it answers
    // `effort: none` with a 400.
    expect(
      deriveReasoningLevels({
        slug: 'google/gemini-3.5-flash',
        supportedParameters: ['tools', 'reasoning', 'reasoning_effort'],
        supportedEfforts: ['high', 'medium', 'low', 'minimal'],
        mandatory: true,
      }),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(
      deriveReasoningLevels({
        slug: 'new/thinker',
        supportedParameters: ['reasoning'],
        mandatory: true,
      }),
    ).toEqual(['medium']);
  });

  it('drops an effort with no level of ours, and offers none', () => {
    expect(
      deriveReasoningLevels({
        slug: 'new/model',
        supportedParameters: ['reasoning_effort'],
        supportedEfforts: ['ludicrous', 'high'],
      }),
    ).toEqual(['none', 'high']);
  });

  it('falls back to the heuristic when no efforts are reported', () => {
    expect(
      deriveReasoningLevels({ slug: 'z-ai/glm-4.7', supportedParameters: ['tools', 'reasoning'] }),
    ).toEqual(['none']);
    expect(
      deriveReasoningLevels({ slug: 'openai/gpt-5.2', supportedParameters: ['reasoning_effort'] }),
    ).toEqual(['none', 'minimal', 'low', 'medium', 'high']);
  });

  it('inserts minimal only for an OpenAI model (glm-5.2-like keeps the standard four)', () => {
    expect(
      deriveReasoningLevels({
        slug: 'z-ai/glm-5.2',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning'],
      }),
    ).toEqual(['none', 'low', 'medium', 'high']);
  });

  it('does not add a level for `verbosity` alone', () => {
    expect(
      deriveReasoningLevels({
        slug: 'anthropic/claude-sonnet-5',
        supportedParameters: ['tools', 'reasoning_effort', 'reasoning', 'verbosity'],
      }),
    ).toEqual(['none', 'low', 'medium', 'high']);
  });
});

describe('mapEndpoint', () => {
  const live: OpenRouterEndpoint = {
    tag: 'reka/fp8',
    provider_name: 'Reka',
    context_length: 262_144,
    max_prompt_tokens: null,
    max_completion_tokens: 235_929,
    quantization: 'fp8',
    supported_parameters: ['tools', 'reasoning_effort'],
    pricing: { prompt: '0.0000008775', completion: '0.00000297' },
  };

  it('takes the routing key from the tag, never from the display name', () => {
    expect(mapEndpoint(live)).toEqual({
      providerKey: 'reka/fp8',
      providerName: 'Reka',
      contextWindowTokens: 262_144,
      maxPromptTokens: null,
      maxOutputTokens: 235_929,
      inputMicroUsdPerMTok: 877_500,
      outputMicroUsdPerMTok: 2_970_000,
      supportsTools: true,
      supportsReasoningEffort: true,
      quantization: 'fp8',
    });
  });

  it('drops an endpoint that cannot be routed to or sized', () => {
    expect(mapEndpoint({ ...live, tag: undefined })).toBeNull();
    expect(mapEndpoint({ ...live, context_length: undefined })).toBeNull();
  });
});

describe('modelFieldsFromEndpoints', () => {
  const small: OpenRouterEndpointSnapshot = {
    providerKey: 'reka/fp8',
    providerName: 'Reka',
    contextWindowTokens: 262_144,
    maxPromptTokens: null,
    maxOutputTokens: 235_929,
    inputMicroUsdPerMTok: 877_500,
    outputMicroUsdPerMTok: 2_970_000,
    supportsTools: true,
    supportsReasoningEffort: true,
    quantization: null,
  };
  const large: OpenRouterEndpointSnapshot = {
    ...small,
    providerKey: 'together',
    providerName: 'Together',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 943_717,
    inputMicroUsdPerMTok: 1_400_000,
    outputMicroUsdPerMTok: 4_400_000,
  };

  it('takes the largest window and the highest price', () => {
    expect(modelFieldsFromEndpoints([small, large])).toEqual({
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 943_717,
      inputMicroUsdPerMTok: 1_400_000,
      outputMicroUsdPerMTok: 4_400_000,
    });
  });

  it('lets a separate input cap lower an endpoint below its own window', () => {
    const capped = { ...large, maxPromptTokens: 100_000 };

    expect(modelFieldsFromEndpoints([capped])?.contextWindowTokens).toBe(100_000);
  });

  it('answers null when there is nothing to read', () => {
    expect(modelFieldsFromEndpoints([])).toBeNull();
  });
});

describe('mapModelFields', () => {
  it('falls back to a conservative window when the entry states none', () => {
    const fields = mapModelFields(
      { id: 'tiny/model', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
      8192,
    );

    expect(fields.contextWindowTokens).toBe(8192);
    expect(fields.reasoningLevels).toEqual(['none']);
    expect(fields.supportsVision).toBe(false);
  });
});

describe('fetchOpenRouterModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(): string[] {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          data: [
            { id: 'openai/text-embedding-3-small', pricing: { prompt: '0', completion: '0' } },
          ],
        }),
      );
    });
    return urls;
  }

  it('asks for the text models by default', async () => {
    const urls = stubFetch();
    await fetchOpenRouterModels('https://example.test/api/v1');
    expect(urls).toEqual(['https://example.test/api/v1/models']);
  });

  // `/models` lists no embedding model unless asked by modality (issue #171).
  it('asks for embedding or image models by their output modality', async () => {
    const urls = stubFetch();
    const models = await fetchOpenRouterModels(
      'https://example.test/api/v1',
      undefined,
      'embeddings',
    );
    await fetchOpenRouterModels('https://example.test/api/v1', undefined, 'image');
    expect(urls).toEqual([
      'https://example.test/api/v1/models?output_modalities=embeddings',
      'https://example.test/api/v1/models?output_modalities=image',
    ]);
    expect([...models.keys()]).toEqual(['openai/text-embedding-3-small']);
  });
});
