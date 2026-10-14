import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { decisionsUrl, JEV_DECISION_MODEL, OpenRouterDecisionProvider } from './decision-provider';
import { AiProviderError } from './provider';

const logger = createLogger({ name: 'test', level: 'silent' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function provider(apiKey = 'sk-test'): OpenRouterDecisionProvider {
  return new OpenRouterDecisionProvider({
    apiKey,
    baseUrl: 'https://openrouter.ai/api/v1',
    logger,
    appUrl: 'https://exocortex.test',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decisionsUrl', () => {
  it('puts the Decisions API beside /v1', () => {
    expect(decisionsUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/alpha/decisions',
    );
    expect(decisionsUrl('https://openrouter.ai/api/v1/')).toBe(
      'https://openrouter.ai/api/alpha/decisions',
    );
  });
});

describe('OpenRouterDecisionProvider', () => {
  it('sends the questions in the wire format and reads every kind of answer back', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: {
          needsImage: { type: 'noul', noul: 0.91 },
          mood: { type: 'choice', choice: 'calm', probabilities: { calm: 0.8, none: 0.2 } },
          urgency: { type: 'score', score: 1.4, probabilities: [0.1, 0.4, 0.5], confidence: 0.3 },
        },
        usage: { input_tokens: 350, output_tokens: 53, cost: 0.0000147 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await provider().decide({
      model: JEV_DECISION_MODEL,
      state: 'Was zeigt diese Skizze?',
      questions: {
        needsImage: { kind: 'yesNo', instructions: 'Does this need a picture?' },
        mood: { kind: 'choice', instructions: 'Mood?', options: { calm: 'calm', none: 'other' } },
        urgency: { kind: 'score', instructions: 'Urgency?', levels: ['low', 'mid', 'high'] },
      },
      correlationId: 'c1',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JSON.parse(String(init.body))).toEqual({
      model: JEV_DECISION_MODEL,
      state: 'Was zeigt diese Skizze?',
      questions: {
        needsImage: { type: 'noul', instructions: 'Does this need a picture?' },
        mood: { type: 'choice', instructions: 'Mood?', criteria: { calm: 'calm', none: 'other' } },
        urgency: { type: 'score', instructions: 'Urgency?', criteria: ['low', 'mid', 'high'] },
      },
    });
    expect(result.answers).toEqual({
      needsImage: { kind: 'yesNo', probability: 0.91 },
      mood: {
        kind: 'choice',
        choice: 'calm',
        probabilities: { calm: 0.8, none: 0.2 },
        confidence: null,
      },
      urgency: { kind: 'score', score: 1.4, probabilities: [0.1, 0.4, 0.5], confidence: 0.3 },
    });
    expect(result.model).toBe('typesafe/jev-1.13-20260917');
    expect(result.inputTokens).toBe(350);
    expect(result.costMicroUsd).toBe(15);
  });

  it('sends yes and no descriptions as criteria only when given', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ answers: { q: { type: 'noul', noul: 0.2 } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await provider().decide({
      model: JEV_DECISION_MODEL,
      state: 's',
      questions: { q: { kind: 'yesNo', instructions: 'i', yes: 'needs it' } },
      correlationId: 'c1',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).questions.q).toEqual({
      type: 'noul',
      instructions: 'i',
      criteria: { true: 'needs it' },
    });
  });

  it('refuses without a key instead of calling out', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      provider('').decide({
        model: JEV_DECISION_MODEL,
        state: 's',
        questions: {},
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'ai_decision_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an upstream error into a typed refusal carrying the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'nope' } }, 503)),
    );

    const failure = await provider()
      .decide({ model: JEV_DECISION_MODEL, state: 's', questions: {}, correlationId: 'c' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiProviderError);
    expect(failure).toMatchObject({ code: 'ai_decision_unavailable', status: 503 });
  });

  it('refuses a missing answer rather than defaulting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ answers: {} })),
    );

    await expect(
      provider().decide({
        model: JEV_DECISION_MODEL,
        state: 's',
        questions: { q: { kind: 'yesNo', instructions: 'i' } },
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'ai_decision_invalid' });
  });

  it('refuses an answer of the wrong kind or an option nobody offered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ answers: { q: { type: 'noul', noul: 0.5 } } })),
    );
    await expect(
      provider().decide({
        model: JEV_DECISION_MODEL,
        state: 's',
        questions: { q: { kind: 'choice', instructions: 'i', options: { a: 'a' } } },
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'ai_decision_invalid' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ answers: { q: { type: 'choice', choice: 'b' } } })),
    );
    await expect(
      provider().decide({
        model: JEV_DECISION_MODEL,
        state: 's',
        questions: { q: { kind: 'choice', instructions: 'i', options: { a: 'a' } } },
        correlationId: 'c',
      }),
    ).rejects.toMatchObject({ code: 'ai_decision_invalid' });
  });
});
