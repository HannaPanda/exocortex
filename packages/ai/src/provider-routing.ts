import {
  mergeProviderRouting,
  type ProviderRouting,
  readProviderRoutingOverride,
} from '@exocortex/contracts';

/** How long one model's merged preferences are reused, the same as the worker's settings cache. */
const PROVIDER_ROUTING_CACHE_TTL_MS = 15_000;

/**
 * The function an OpenRouter adapter asks for a model's provider preferences
 * (issue #135, ADR-063).
 *
 * Every model call asks, so the answer is cached per model for a few seconds:
 * a run of forty turns must not cost eighty reads. Where the two halves come
 * from is the caller's business -- the worker and the API read settings
 * differently -- which is also what keeps this package free of a database.
 */
export function createProviderRoutingResolver(input: {
  /** The setting `ai.providerRouting`, as the process currently resolves it. */
  readGlobal: () => Promise<ProviderRouting>;
  /** The raw `ai_model.providerRouting` column for a slug, `null` when the model is not registered. */
  readOverride: (model: string) => Promise<unknown>;
  now?: () => number;
}): (model: string) => Promise<ProviderRouting> {
  const now = input.now ?? Date.now;
  const cache = new Map<string, { value: ProviderRouting; expiresAt: number }>();
  return async (model: string): Promise<ProviderRouting> => {
    const cached = cache.get(model);
    if (cached !== undefined && cached.expiresAt > now()) return cached.value;
    const [global, override] = await Promise.all([input.readGlobal(), input.readOverride(model)]);
    const value = mergeProviderRouting(global, readProviderRoutingOverride(override));
    cache.set(model, { value, expiresAt: now() + PROVIDER_ROUTING_CACHE_TTL_MS });
    return value;
  };
}
