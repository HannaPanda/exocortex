import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { EMBEDDING_MAX_INPUT_TOKENS } from './embedding-budget';
import {
  createEmbeddingClient,
  createEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_TOO_LONG,
  type EmbeddingProvider,
  type EmbeddingRequest,
  hashEmbedding,
  MockEmbeddingProvider,
  OpenRouterEmbeddingProvider,
} from './embedding-provider';
import { AiProviderError } from './provider';

const logger = createLogger({ name: 'test', level: 'silent' });

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0);
  return dot;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('hashEmbedding', () => {
  it('normalises to unit length', () => {
    const vector = hashEmbedding('Ein Satz über Termine', 64);
    expect(cosine(vector, vector)).toBeCloseTo(1, 6);
  });

  it('gives shared vocabulary a higher similarity than unrelated text', () => {
    const a = hashEmbedding('Kalender Termine Erinnerungen', 512);
    const b = hashEmbedding('Termine und Erinnerungen im Kalender', 512);
    const c = hashEmbedding('Migration der Datenbank rollt zurück', 512);

    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });

  it('answers a text without words with a usable vector', () => {
    const vector = hashEmbedding('   ...   ', 8);
    expect(cosine(vector, vector)).toBeCloseTo(1, 6);
  });
});

describe('MockEmbeddingProvider', () => {
  it('returns one vector per input, in order, without touching the network', async () => {
    const result = await new MockEmbeddingProvider().embed({
      input: ['erster Text', 'zweiter Text'],
      model: 'irrelevant',
      correlationId: 'c1',
    });

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.vectors[0]).toEqual(hashEmbedding('erster Text', EMBEDDING_DIMENSIONS));
  });

  it('honours a requested dimension', async () => {
    const result = await new MockEmbeddingProvider().embed({
      input: ['kurz'],
      model: 'irrelevant',
      dimensions: 16,
      correlationId: 'c1',
    });

    expect(result.vectors[0]).toHaveLength(16);
  });
});

describe('OpenRouterEmbeddingProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const provider = new OpenRouterEmbeddingProvider({
    apiKey: 'key',
    baseUrl: 'https://openrouter.test/api/v1',
    logger,
    appUrl: 'https://exocortex.test',
  });

  it('asks for the configured dimension and reports the cost in micro-USD', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [{ index: 0, embedding: [0.5, 0.5] }],
        model: 'text-embedding-3-small',
        usage: { total_tokens: 7, cost: 0.000_004 },
      }),
    );

    const result = await provider.embed({
      input: ['Hallo Welt'],
      model: 'openai/text-embedding-3-small',
      dimensions: 1536,
      correlationId: 'c1',
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      model: string;
      input: string[];
      dimensions: number;
    };
    expect(body.dimensions).toBe(1536);
    expect(body.input).toEqual(['Hallo Welt']);
    expect(result.totalTokens).toBe(7);
    expect(result.costMicroUsd).toBe(4);
  });

  it('orders vectors by the index the response carries, not by arrival', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    );

    const result = await provider.embed({
      input: ['erster', 'zweiter'],
      model: 'm',
      correlationId: 'c1',
    });

    expect(result.vectors).toEqual([[1], [2]]);
  });

  it('refuses a response that is missing a vector instead of misaligning them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: [{ index: 0, embedding: [1] }] }),
    );

    await expect(
      provider.embed({ input: ['a', 'b'], model: 'm', correlationId: 'c1' }),
    ).rejects.toThrow(AiProviderError);
  });

  it('never calls out without a key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const keyless = new OpenRouterEmbeddingProvider({
      apiKey: '',
      baseUrl: 'https://openrouter.test/api/v1',
      logger,
      appUrl: 'https://exocortex.test',
    });

    await expect(keyless.embed({ input: ['a'], model: 'm', correlationId: 'c1' })).rejects.toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names a refusal for length, so it can be told from an outage (issue #329)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          error: {
            message: "HTTP 400: Invalid 'input[0]': maximum input length is 8192 tokens.",
            code: 400,
          },
        },
        400,
      ),
    );

    await expect(
      provider.embed({ input: ['a'], model: 'm', correlationId: 'c1' }),
    ).rejects.toMatchObject({ code: EMBEDDING_INPUT_TOO_LONG, status: 400 });
  });

  it('keeps every other refusal an outage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error: { message: 'Insufficient credits' } }, 402),
    );

    await expect(
      provider.embed({ input: ['a'], model: 'm', correlationId: 'c1' }),
    ).rejects.toMatchObject({ code: 'ai_embedding_unavailable' });
  });

  it('returns nothing for no input without a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await provider.embed({ input: [], model: 'm', correlationId: 'c1' });

    expect(result.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createEmbeddingProvider', () => {
  it('gives a mock deployment offline embeddings', () => {
    const provider = createEmbeddingProvider({
      providerId: 'mock',
      logger,
      appUrl: 'https://exocortex.test',
      apiKey: '',
      baseUrl: 'https://openrouter.test/api/v1',
    });

    expect(provider).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('returns null when OpenRouter is selected without a key', () => {
    expect(
      createEmbeddingProvider({
        providerId: 'openrouter',
        logger,
        appUrl: 'https://exocortex.test',
        apiKey: '',
        baseUrl: 'https://openrouter.test/api/v1',
      }),
    ).toBeNull();
  });
});

describe('createEmbeddingClient', () => {
  /** A provider that answers from a script of failures, then with vectors. */
  function scripted(failures: Error[]): { provider: EmbeddingProvider; calls: EmbeddingRequest[] } {
    const calls: EmbeddingRequest[] = [];
    const provider: EmbeddingProvider = {
      id: 'scripted',
      embed: async (request) => {
        calls.push(request);
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        return {
          vectors: request.input.map(() => [1]),
          model: request.model,
          totalTokens: 0,
          costMicroUsd: null,
        };
      },
    };
    return { provider, calls };
  }

  const tooLong = (): AiProviderError =>
    new AiProviderError(EMBEDDING_INPUT_TOO_LONG, 'maximum input length is 8192 tokens', {
      status: 400,
    });

  it('fits what it is handed to the token budget, not to a character count', () => {
    const client = createEmbeddingClient(new MockEmbeddingProvider());
    const figures = '12.345,67 EUR | 01.02.2026 | 4711-0815\n'.repeat(600);

    const fitted = client?.fitInput(figures) ?? '';

    expect(fitted.length).toBeLessThan(figures.length);
    expect(figures.startsWith(fitted)).toBe(true);
  });

  it('answers a refusal for length once more, with only the texts that could be too long cut to the byte bound', async () => {
    const { provider, calls } = scripted([tooLong()]);
    const client = createEmbeddingClient(provider);
    const passage = 'Ein Absatz.';
    const long = '9'.repeat(EMBEDDING_MAX_INPUT_TOKENS * 2);

    const vectors = await client?.embed({
      texts: [passage, long],
      model: 'm',
      correlationId: 'c1',
    });

    expect(vectors).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.input[0]).toBe(passage);
    expect(calls[1]?.input[1]).toHaveLength(EMBEDDING_MAX_INPUT_TOKENS);
  });

  it('asks only once more, so a refusal can never become a loop', async () => {
    const { provider, calls } = scripted([tooLong(), tooLong()]);
    const client = createEmbeddingClient(provider);

    await expect(
      client?.embed({ texts: ['x'.repeat(20_000)], model: 'm', correlationId: 'c1' }),
    ).rejects.toMatchObject({ code: EMBEDDING_INPUT_TOO_LONG });
    expect(calls).toHaveLength(2);
  });

  it('does not retry an outage', async () => {
    const { provider, calls } = scripted([
      new AiProviderError('ai_embedding_unavailable', 'no credit'),
    ]);
    const client = createEmbeddingClient(provider);

    await expect(
      client?.embed({ texts: ['a'], model: 'm', correlationId: 'c1' }),
    ).rejects.toMatchObject({ code: 'ai_embedding_unavailable' });
    expect(calls).toHaveLength(1);
  });
});
