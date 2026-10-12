import { afterEach, describe, expect, it, vi } from 'vitest';

import { AI_MODEL_PROVIDERS } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';

import { type AiStreamEvent } from './provider';
import { PROVIDER_PRESETS } from './provider-presets';
import { createPresetProvider } from './registry';

const logger = createLogger({ name: 'test', level: 'silent' });

function cline(apiKey = 'cline-key') {
  return createPresetProvider({
    presetId: 'cline',
    apiKey,
    logger,
    appUrl: 'https://exocortex.test',
  });
}

function streamResponse(chunks: readonly unknown[]): Response {
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n')}\ndata: [DONE]\n`;
  return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const collected: AiStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const request = {
  model: 'cline-pass/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'Sag nur: ok' }],
  correlationId: 'test-correlation',
} as const;

/** Answers every request with `respond()` and keeps what was sent. */
function stubFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** The JSON body of the n-th request. */
function sentBody(calls: readonly { init: RequestInit }[], call = 0): Record<string, unknown> {
  return JSON.parse(String(calls[call]?.init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider presets (issue #187)', () => {
  it('only names providers a registry row may name', () => {
    for (const id of Object.keys(PROVIDER_PRESETS)) {
      expect(AI_MODEL_PROVIDERS).toContain(id);
    }
  });

  it('sends a key only to a fixed HTTPS address', () => {
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      expect(new URL(preset.baseUrl).protocol).toBe('https:');
    }
  });

  it('maps every subscription model onto an OpenRouter slug', () => {
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      for (const [slug, equivalent] of Object.entries(preset.openRouterEquivalents)) {
        expect(slug).not.toBe(equivalent);
        expect(equivalent).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
      }
    }
  });
});

describe('the Cline preset', () => {
  it('reads an answer out of its envelope', async () => {
    const { calls } = stubFetch(() =>
      Response.json({
        success: true,
        data: {
          model: 'deepseek/deepseek-v4.1-flash',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 35,
            completion_tokens: 2,
            cost: 0.00002625,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
      }),
    );

    const result = await cline().generate(request);

    expect(result.text).toBe('ok');
    expect(result.usage).toMatchObject({
      provider: 'cline',
      inputTokens: 35,
      providerCostMicroUsd: 26,
    });
    expect(calls[0]?.url).toBe('https://api.cline.bot/api/v1/chat/completions');
  });

  it("asks for usage the OpenAI way and sends none of OpenRouter's fields", async () => {
    const { calls } = stubFetch(() =>
      streamResponse([
        { choices: [{ delta: { content: 'ok' } }] },
        {
          model: 'deepseek/deepseek-v4.1-flash',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 31_295, completion_tokens: 49, cost: 0.00015 },
        },
      ]),
    );

    await collect(cline().stream({ ...request, routing: { allowedProviderKeys: ['together'] } }));

    const body = sentBody(calls);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty('usage');
    expect(body).not.toHaveProperty('provider');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('HTTP-Referer');
  });

  it('measures the time to the first fragment of a stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([
          { choices: [{ delta: { reasoning: 'denkt' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          },
        ]),
      ),
    );

    const events = await collect(cline().stream(request));
    const usage = events.find((event) => event.type === 'usage');

    expect(usage?.type === 'usage' ? usage.usage.firstTokenMs : undefined).toEqual(
      expect.any(Number),
    );
  });

  it('carries the upstream status on a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('quota', { status: 429 })),
    );

    const events = await collect(cline().stream(request));

    expect(events).toContainEqual({
      type: 'error',
      code: 'ai_provider_unavailable',
      message: 'Cline responded with 429',
      status: 429,
    });
  });

  it('refuses to run without its key, naming the variable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(cline('').generate(request)).rejects.toThrow(/CLINE_API_KEY is empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
