import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { isFallbackStatus, withFallback } from './fallback-provider';
import {
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  AiProviderError,
  type AiStreamEvent,
} from './provider';

const logger = createLogger({ name: 'test', level: 'silent' });

const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  provider: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash',
  providerCostMicroUsd: 1,
  durationMs: 1,
};

/** A provider that streams the given events and records what it was asked. */
function scripted(
  id: string,
  events: readonly AiStreamEvent[],
  generate?: (request: AiGenerateRequest) => Promise<AiGenerateResult>,
) {
  const requests: AiGenerateRequest[] = [];
  const provider: AiProvider = {
    id,
    capabilities: {
      textGeneration: true,
      vision: false,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      contextWindowTokens: 1000,
      usageReporting: true,
      costReporting: true,
      models: [],
      reasoningControl: false,
    },
    async generate(request) {
      requests.push(request);
      if (generate === undefined) throw new Error('not scripted');
      return generate(request);
    },
    async *stream(request) {
      requests.push(request);
      yield* events;
    },
  };
  return { provider, requests };
}

async function collect(events: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const collected: AiStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const request: AiGenerateRequest = {
  model: 'cline-pass/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'Hallo' }],
  correlationId: 'test',
  routing: { allowedProviderKeys: ['deepseek'] },
};

const answer: AiStreamEvent[] = [
  { type: 'start', model: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter' },
  { type: 'delta', text: 'Hallo zurück', sequence: 1 },
  { type: 'done', text: 'Hallo zurück', finishReason: 'stop' },
];

const modelFor = (model: string | undefined): string | null =>
  model === 'cline-pass/deepseek-v4.1-flash' ? 'deepseek/deepseek-v4.1-flash' : null;

describe('isFallbackStatus', () => {
  it('takes "not now" and leaves "wrong" alone', () => {
    expect([402, 408, 429, 500, 503].map(isFallbackStatus)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404].map(isFallbackStatus)).toEqual([false, false, false, false]);
    expect(isFallbackStatus(undefined)).toBe(false);
  });
});

describe('withFallback (issue #187)', () => {
  it('hands a turn refused before answering to the equivalent model', async () => {
    const primary = scripted('cline', [
      { type: 'start', model: request.model!, provider: 'cline' },
      {
        type: 'error',
        code: 'ai_provider_unavailable',
        message: 'Cline responded with 429',
        status: 429,
      },
    ]);
    const secondary = scripted('openrouter', answer);

    const events = await collect(
      withFallback(primary.provider, secondary.provider, { logger, modelFor }).stream(request),
    );

    expect(events).toEqual(answer);
    expect(secondary.requests[0]?.model).toBe('deepseek/deepseek-v4.1-flash');
    // The primary's plan describes the primary's endpoints.
    expect(secondary.requests[0]?.routing).toBeUndefined();
  });

  it('keeps a refusal about the request or the key a failure', async () => {
    const refusal: AiStreamEvent[] = [
      { type: 'start', model: request.model!, provider: 'cline' },
      {
        type: 'error',
        code: 'ai_provider_unavailable',
        message: 'Cline responded with 401',
        status: 401,
      },
    ];
    const secondary = scripted('openrouter', answer);

    const events = await collect(
      withFallback(scripted('cline', refusal).provider, secondary.provider, {
        logger,
        modelFor,
      }).stream(request),
    );

    expect(events).toEqual(refusal);
    expect(secondary.requests).toHaveLength(0);
  });

  it('never replays a turn that has started answering', async () => {
    const halfway: AiStreamEvent[] = [
      { type: 'start', model: request.model!, provider: 'cline' },
      { type: 'delta', text: 'Hal', sequence: 1 },
      { type: 'error', code: 'ai_provider_unavailable', message: 'gone', status: 502 },
    ];
    const secondary = scripted('openrouter', answer);

    const events = await collect(
      withFallback(scripted('cline', halfway).provider, secondary.provider, {
        logger,
        modelFor,
      }).stream(request),
    );

    expect(events).toEqual(halfway);
    expect(secondary.requests).toHaveLength(0);
  });

  it('fails as before for a model with no equivalent', async () => {
    const refusal: AiStreamEvent[] = [
      { type: 'error', code: 'ai_provider_unavailable', message: 'quota', status: 429 },
    ];
    const secondary = scripted('openrouter', answer);

    const events = await collect(
      withFallback(scripted('cline', refusal).provider, secondary.provider, {
        logger,
        modelFor,
      }).stream({ ...request, model: 'cline-pass/something-else' }),
    );

    expect(events).toEqual(refusal);
    expect(secondary.requests).toHaveLength(0);
  });

  it('falls back when the request never reached the upstream', async () => {
    const unreachable: AiProvider = {
      ...scripted('cline', []).provider,
      // Fails before its first event, like a fetch that never got an answer.
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<AiStreamEvent>> => {
            throw new TypeError('fetch failed');
          },
        }),
      }),
    };
    const secondary = scripted('openrouter', answer);

    const events = await collect(
      withFallback(unreachable, secondary.provider, { logger, modelFor }).stream(request),
    );

    expect(events).toEqual(answer);
  });

  it('does not fall back from a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const refusal: AiStreamEvent[] = [
      { type: 'error', code: 'ai_provider_unavailable', message: 'quota', status: 429 },
    ];
    const secondary = scripted('openrouter', answer);

    await collect(
      withFallback(scripted('cline', refusal).provider, secondary.provider, {
        logger,
        modelFor,
      }).stream({ ...request, signal: controller.signal }),
    );

    expect(secondary.requests).toHaveLength(0);
  });

  it('falls back from a refused generate call', async () => {
    const primary = scripted('cline', [], async () => {
      throw new AiProviderError('ai_provider_unavailable', 'quota', { status: 402 });
    });
    const result: AiGenerateResult = {
      text: 'ok',
      finishReason: 'stop',
      usage,
      toolCalls: [],
    };
    const generate = vi.fn(async () => result);
    const secondary = scripted('openrouter', [], generate);

    const answered = await withFallback(primary.provider, secondary.provider, {
      logger,
      modelFor,
    }).generate(request);

    expect(answered).toBe(result);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'deepseek/deepseek-v4.1-flash' }),
    );
  });
});
