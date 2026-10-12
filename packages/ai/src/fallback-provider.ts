import { type Logger } from '@exocortex/logger';

import {
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  AiProviderError,
  type AiStreamEvent,
} from './provider';

/**
 * The upstream statuses that say "not now, not from me": a used-up quota or
 * plan (402, 429), a timeout (408) and an upstream fault (5xx). A 400, 401,
 * 403 or 404 is about the request or the key, and another provider answering
 * it would hide a fault somebody has to fix.
 */
export function isFallbackStatus(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return status === 402 || status === 408 || status === 429 || status >= 500;
}

export interface FallbackOptions {
  logger: Logger;
  /** The secondary's model for the primary's, or null when there is none to fall back to. */
  modelFor: (model: string | undefined) => string | null;
}

/**
 * A provider that hands a refused turn to a second one (issue #187).
 *
 * Only a refusal before the answer began counts: an error status on the
 * response itself, or a request that never reached the upstream. Once a single
 * fragment has arrived the turn belongs to the primary, because replaying it
 * elsewhere could write twice what the first half already set in motion. The
 * secondary reports its own `start` and usage, so the run records truthfully
 * who answered and who was paid. Whether to wrap at all is the caller's
 * decision, made from the opt-in setting `ai.subscriptionFallback`.
 */
export function withFallback(
  primary: AiProvider,
  secondary: AiProvider,
  options: FallbackOptions,
): AiProvider {
  const rerouted = (
    request: AiGenerateRequest,
    status: number | null,
  ): AiGenerateRequest | null => {
    if (request.signal?.aborted === true) return null;
    const model = options.modelFor(request.model);
    if (model === null) return null;
    options.logger.info('Provider refused the turn; falling back', {
      correlationId: request.correlationId,
      from: primary.id,
      to: secondary.id,
      status,
      model: request.model,
      fallbackModel: model,
    });
    // The primary's routing plan describes the primary's endpoints, so it
    // cannot travel along; the secondary plans with its own configuration.
    return { ...request, model, routing: undefined };
  };

  return {
    id: primary.id,
    capabilities: primary.capabilities,

    async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
      try {
        return await primary.generate(request);
      } catch (error: unknown) {
        const status = refusalStatus(error);
        const next = status === undefined ? null : rerouted(request, status);
        if (next === null) throw error;
        return secondary.generate(next);
      }
    },

    async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
      const iterator = primary.stream(request)[Symbol.asyncIterator]();
      const held: AiStreamEvent[] = [];
      let first: IteratorResult<AiStreamEvent> | null = null;
      let next: AiGenerateRequest | null = null;

      // Read up to the first event that is not `start`, deciding before
      // anything reaches the caller. Nothing is yielded inside the `try`, so
      // an error the caller throws into this generator is never mistaken for
      // the provider's.
      try {
        while (first === null) {
          const result = await iterator.next();
          if (!result.done && result.value.type === 'start') {
            held.push(result.value);
            continue;
          }
          first = result;
        }
        if (!first.done && first.value.type === 'error' && isFallbackStatus(first.value.status)) {
          next = rerouted(request, first.value.status ?? null);
        }
      } catch (error: unknown) {
        const status = refusalStatus(error);
        next = status === undefined ? null : rerouted(request, status);
        if (next === null) throw error;
      }

      if (next !== null) {
        await iterator.return?.();
        yield* secondary.stream(next);
        return;
      }
      yield* held;
      if (first === null || first.done === true) return;
      yield first.value;
      while (true) {
        const result = await iterator.next();
        if (result.done === true) return;
        yield result.value;
      }
    },
  };
}

/**
 * The status that makes a thrown error a refusal another provider may take:
 * the HTTP status of a provider error, `null` for a request that never got an
 * answer at all (the network), `undefined` for anything else.
 */
function refusalStatus(error: unknown): number | null | undefined {
  if (error instanceof AiProviderError) {
    return isFallbackStatus(error.status) ? error.status : undefined;
  }
  if (error instanceof Error && error.name === 'AbortError') return undefined;
  return error instanceof TypeError ? null : undefined;
}
