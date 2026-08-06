import { type Logger } from '@exocortex/logger';

import { MockAiProvider } from './mock-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { type AiProvider } from './provider';
import { VisionPreprocessor } from './vision-preprocessor';

export type AiProviderId = 'mock' | 'openrouter';

export interface CreateProviderOptions {
  providerId: AiProviderId;
  logger: Logger;
  appUrl: string;
  openRouter?: { apiKey: string; baseUrl: string; defaultModel?: string };
}

/**
 * Resolves the configured provider.
 *
 * `mock` is the default and the only provider enabled in this version.
 */
export function createAiProvider(options: CreateProviderOptions): AiProvider {
  if (options.providerId === 'openrouter') {
    return new OpenRouterProvider({
      apiKey: options.openRouter?.apiKey ?? '',
      baseUrl: options.openRouter?.baseUrl ?? 'https://openrouter.ai/api/v1',
      defaultModel: options.openRouter?.defaultModel,
      logger: options.logger,
      appUrl: options.appUrl,
    });
  }
  return new MockAiProvider();
}

export interface CreateVisionPreprocessorOptions {
  logger: Logger;
  appUrl: string;
  apiKey: string;
  baseUrl: string;
  /** No model configured means "skip vision preprocessing". */
  model?: string;
}

/**
 * Resolves the configured vision preprocessor, or `null` when unconfigured.
 *
 * Mirrors `OpenRouterProvider`'s own safety gate: without both a model and an
 * API key this can never silently start making paid calls. Callers must treat
 * `null` as "skip preprocessing", not as an error.
 */
export function createVisionPreprocessor(
  options: CreateVisionPreprocessorOptions,
): VisionPreprocessor | null {
  if (options.apiKey.length === 0 || options.model === undefined || options.model.length === 0) {
    return null;
  }
  return new VisionPreprocessor({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    appUrl: options.appUrl,
    logger: options.logger,
  });
}

// PDF text extraction (D6) is wired directly from `createPdfTextExtractor` in
// `pdf-text.ts` -- it already has the exact "null when apiKey/model are
// unconfigured" seam this file gives `createVisionPreprocessor`, so wrapping it
// again here would only duplicate the function. `createVisionPreprocessor`
// above already takes `model` per call (not closed over the env value), which
// is what lets the worker pass a per-run companion model; the same is true of
// `createPdfTextExtractor`.
