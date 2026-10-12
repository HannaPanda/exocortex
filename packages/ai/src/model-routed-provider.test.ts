import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { MockAiProvider } from './mock-provider';
import { routeByModel } from './model-routed-provider';
import { type AiGenerateRequest } from './provider';

const logger = createLogger({ name: 'test', level: 'silent' });

const CLINE_ANSWER = {
  success: true,
  data: {
    model: 'deepseek/deepseek-v4.1-flash',
    choices: [{ finish_reason: 'stop', message: { content: 'vom Abo' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000001 },
  },
};

function router(rows: Record<string, string>, fallbackEnabled = false) {
  const base = new MockAiProvider();
  const baseGenerate = vi.spyOn(base, 'generate');
  const provider = routeByModel({
    base,
    providerOf: async (slug) => rows[slug] ?? null,
    presetKeys: { cline: 'test-key' },
    fallbackEnabled: async () => fallbackEnabled,
    logger,
    appUrl: 'https://exocortex.test',
  });
  return { provider, baseGenerate };
}

function ask(model: string | undefined): AiGenerateRequest {
  return { messages: [{ role: 'user', content: 'Hallo' }], model, correlationId: 'test' };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routeByModel (issue #187)', () => {
  it('sends a model registered for a preset to that preset, not to the base', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json(CLINE_ANSWER),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { provider, baseGenerate } = router({ 'cline-pass/deepseek-v4.1-flash': 'cline' });

    const result = await provider.generate(ask('cline-pass/deepseek-v4.1-flash'));

    expect(result.text).toBe('vom Abo');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.cline.bot/api/v1/chat/completions');
    expect(baseGenerate).not.toHaveBeenCalled();
  });

  it('leaves every other model, and a request naming none, with the base', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { provider, baseGenerate } = router({ 'deepseek/deepseek-v4.1-flash': 'openrouter' });

    await provider.generate(ask('deepseek/deepseek-v4.1-flash'));
    await provider.generate(ask('unbekannt/modell'));
    await provider.generate(ask(undefined));

    expect(baseGenerate).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands a refused preset turn to the base with its OpenRouter model when allowed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('quota', { status: 429 })),
    );
    const { provider, baseGenerate } = router({ 'cline-pass/deepseek-v4.1-flash': 'cline' }, true);

    await provider.generate(ask('cline-pass/deepseek-v4.1-flash'));

    expect(baseGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek/deepseek-v4.1-flash' }),
    );
  });
});
