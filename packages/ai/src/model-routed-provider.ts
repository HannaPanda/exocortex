import { type Logger } from '@exocortex/logger';

import { type AiGenerateRequest, type AiProvider } from './provider';
import { isProviderPresetId, type ProviderPresetId } from './provider-presets';
import { createPresetProviderWithFallback } from './registry';

export interface ModelRoutingOptions {
  /** OpenRouter (or the mock): who serves every model no preset claims. */
  base: AiProvider;
  /** The registry row's `provider` for a slug, or null when there is no row. */
  providerOf: (slug: string) => Promise<string | null>;
  presetKeys: Readonly<Record<ProviderPresetId, string>>;
  /** Reads `ai.subscriptionFallback` per call, so switching it needs no restart. */
  fallbackEnabled: () => Promise<boolean>;
  logger: Logger;
  appUrl: string;
}

/**
 * A provider that asks the model registry who serves each request (issue #187).
 *
 * The background jobs (memory capture and consolidation, overview pages,
 * automations, the checkpoint summary) take a model slug from a setting and
 * were handed the deployment's OpenRouter provider at boot. Once
 * `ai.defaultModelSlug` names a preset's model, that slug means nothing to
 * OpenRouter; routing here keeps every one of those callers unchanged. An AI
 * run does not come through this: it reads the provider off its own row.
 */
export function routeByModel(options: ModelRoutingOptions): AiProvider {
  const resolve = async (request: AiGenerateRequest): Promise<AiProvider> => {
    if (request.model === undefined) return options.base;
    const providerId = await options.providerOf(request.model);
    if (providerId === null || !isProviderPresetId(providerId)) return options.base;
    return createPresetProviderWithFallback({
      presetId: providerId,
      apiKey: options.presetKeys[providerId],
      fallback: options.base,
      fallbackEnabled: options.fallbackEnabled,
      logger: options.logger,
      appUrl: options.appUrl,
    });
  };

  return {
    id: options.base.id,
    capabilities: options.base.capabilities,
    async generate(request) {
      return (await resolve(request)).generate(request);
    },
    async *stream(request) {
      yield* (await resolve(request)).stream(request);
    },
  };
}
