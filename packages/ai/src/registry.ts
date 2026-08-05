import { type Logger } from '@exocortex/logger';

import { MockAiProvider } from './mock-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { type AiProvider } from './provider';

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
