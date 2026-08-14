import { createHash } from 'node:crypto';

import { z } from 'zod';

import { type Logger } from '@exocortex/logger';

import { AiProviderError } from './provider';

/**
 * Turning text into a vector.
 *
 * Deliberately a separate contract from `AiProvider`: an embedding model does
 * not chat, has no tools, no streaming and no finish reason, and modelling it
 * as a degenerate chat provider would put six unused fields on every call.
 * What both share is the safety gate -- a provider without an API key refuses
 * rather than silently making paid calls.
 */

/** The dimension the `document_embedding.embedding` column is declared with. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Longest text one embedding is built from.
 *
 * `text-embedding-3-small` accepts 8191 tokens, which is roughly 30k characters
 * of German prose. Cutting at 24k leaves room for the token estimate to be
 * wrong in the expensive direction. A page longer than this loses its tail from
 * the *semantic* index only: full-text search still sees every word, and
 * per-block chunking (the `blockId` column) is the way to fix it properly.
 */
export const EMBEDDING_MAX_CHARS = 24_000;

/** Texts sent in one request. OpenRouter accepts far more; this bounds one failure. */
export const EMBEDDING_BATCH_SIZE = 32;

export interface EmbeddingRequest {
  /** One vector comes back per entry, in the same order. */
  input: readonly string[];
  model: string;
  /**
   * Dimension the caller needs. Models of the `text-embedding-3` family and
   * Gemini's shorten their output on request (Matryoshka), which is what lets a
   * 3072-dimension model be stored in a 1536-dimension column. A provider that
   * cannot honour it must return its natural length and let the caller refuse.
   */
  dimensions?: number;
  correlationId: string;
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: readonly (readonly number[])[];
  model: string;
  totalTokens: number;
  /** Micro-USD as the provider reported it, `null` when it reports no cost. */
  costMicroUsd: number | null;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

export interface OpenRouterEmbeddingProviderOptions {
  apiKey: string;
  baseUrl: string;
  logger: Logger;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
}

/**
 * OpenRouter's `/embeddings` endpoint, which is OpenAI-shaped.
 *
 * Using the account that already drives the rest of the AI features is the
 * whole reason semantic search needs no second service, no container and no
 * additional key: `openai/text-embedding-3-small` costs about two cents per
 * million tokens, so indexing a workspace is cents, not euros.
 */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  public readonly id = 'openrouter';

  constructor(private readonly options: OpenRouterEmbeddingProviderOptions) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.options.apiKey.length === 0) {
      throw new AiProviderError(
        'ai_embedding_unavailable',
        'Embeddings are enabled but OPENROUTER_API_KEY is empty.',
      );
    }
    if (request.input.length === 0) {
      return { vectors: [], model: request.model, totalTokens: 0, costMicroUsd: null };
    }

    const response = await fetch(`${this.options.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': this.options.appUrl,
        'X-Title': 'eXocortex',
      },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        ...(request.dimensions === undefined ? {} : { dimensions: request.dimensions }),
      }),
      signal: request.signal ?? null,
    });

    if (!response.ok) {
      const detail = await response.text();
      this.options.logger.error('Embedding request failed', undefined, {
        status: response.status,
        model: request.model,
        correlationId: request.correlationId,
      });
      throw new AiProviderError(
        'ai_embedding_unavailable',
        `OpenRouter responded with ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const parsed = embeddingResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AiProviderError(
        'ai_embedding_invalid',
        'OpenRouter returned an embedding response in an unexpected shape.',
      );
    }

    /**
     * The wire format carries an explicit `index` and is not promised to arrive
     * in order, so the vectors are placed by index rather than by position. A
     * gap means the response is unusable: silently embedding page A with page
     * B's vector would poison the index in a way nothing later detects.
     */
    const byIndex = new Map(parsed.data.data.map((entry) => [entry.index, entry.embedding]));
    const vectors: number[][] = [];
    for (let index = 0; index < request.input.length; index += 1) {
      const vector = byIndex.get(index);
      if (vector === undefined) {
        throw new AiProviderError(
          'ai_embedding_invalid',
          `OpenRouter returned ${parsed.data.data.length} embeddings for ${request.input.length} inputs.`,
        );
      }
      vectors.push(vector);
    }

    const usage = parsed.data.usage;
    return {
      vectors,
      model: parsed.data.model ?? request.model,
      totalTokens: usage?.total_tokens ?? usage?.prompt_tokens ?? 0,
      costMicroUsd: usage?.cost === undefined ? null : Math.round(usage.cost * 1_000_000),
    };
  }
}

/**
 * Deterministic offline embeddings.
 *
 * Hashes every word into one of `dimensions` buckets and normalises the result,
 * which gives two texts sharing vocabulary a high cosine similarity and two
 * unrelated texts a low one. That is not semantics -- it cannot see that
 * "Termin" and "Verabredung" are the same thing -- but it makes the whole
 * pipeline (write, index, search, rank) exercisable in tests and on a
 * deployment running `AI_PROVIDER=mock`, without an account and without
 * network. The same reasoning as `MockImageGenerator`.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  public readonly id = 'mock';

  constructor(private readonly dimensions: number = EMBEDDING_DIMENSIONS) {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const size = request.dimensions ?? this.dimensions;
    return {
      vectors: request.input.map((text) => hashEmbedding(text, size)),
      model: request.model,
      totalTokens: 0,
      costMicroUsd: 0,
    };
  }
}

/** Exported for the adapter's tests, which need the same vector the mock builds. */
export function hashEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().split(/[^\p{Letter}\p{Number}_]+/u);
  for (const word of words) {
    if (word.length === 0) continue;
    const digest = createHash('sha256').update(word).digest();
    const bucket = digest.readUInt32BE(0) % dimensions;
    // The sign spreads the vocabulary over the whole space instead of piling
    // every word into the positive orthant, where everything looks similar.
    const sign = digest.readUInt8(4) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (length === 0) {
    // An empty or punctuation-only text has no direction. A zero vector is
    // undefined under cosine distance, so it gets one arbitrary but stable axis.
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / length);
}

/**
 * The provider in the shape `packages/database`'s `HybridSearchAdapter` wants.
 *
 * The adapter cannot import this package (the dependency graph forbids it), so
 * it declares its own `EmbeddingClient` port and this satisfies it
 * structurally. Written once here rather than in both composition roots; if
 * the two shapes ever drift, the assignment in `apps/api` and `apps/worker`
 * stops compiling, which is where it should be noticed.
 */
export function createEmbeddingClient(provider: EmbeddingProvider | null): {
  dimensions: number;
  maxInputChars: number;
  embed(input: {
    texts: readonly string[];
    model: string;
    correlationId: string;
  }): Promise<readonly (readonly number[])[]>;
} | null {
  if (provider === null) return null;
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    maxInputChars: EMBEDDING_MAX_CHARS,
    embed: async (input) => {
      const result = await provider.embed({
        input: input.texts,
        model: input.model,
        dimensions: EMBEDDING_DIMENSIONS,
        correlationId: input.correlationId,
      });
      return result.vectors;
    },
  };
}

export interface CreateEmbeddingProviderOptions {
  providerId: 'mock' | 'openrouter';
  logger: Logger;
  appUrl: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Resolves the embedding provider, or `null` when it cannot work.
 *
 * Same gate as `createVisionPreprocessor`: without a key there is nothing to
 * call, and `null` means "semantic search is unavailable", not "something
 * broke" -- the hybrid adapter then answers from full-text alone. The model is
 * not part of this: it is a runtime setting (ADR-013) and travels per request.
 */
export function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions,
): EmbeddingProvider | null {
  if (options.providerId === 'mock') return new MockEmbeddingProvider();
  if (options.apiKey.length === 0) return null;
  return new OpenRouterEmbeddingProvider({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    logger: options.logger,
    appUrl: options.appUrl,
  });
}
