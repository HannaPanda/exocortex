import {
  type ChatCompletionsDialect,
  ChatCompletionsProvider,
  type ChatCompletionsProviderOptions,
} from './chat-completions-provider';

export type OpenRouterProviderOptions = ChatCompletionsProviderOptions;

/**
 * OpenRouter as a Chat Completions dialect: the routing object of ADR-032 and
 * ADR-063, usage through `usage.include`, the attribution headers it asks for.
 */
export const OPENROUTER_DIALECT: ChatCompletionsDialect = {
  id: 'openrouter',
  label: 'OpenRouter',
  keyName: 'OPENROUTER_API_KEY',
  capabilities: {
    textGeneration: true,
    vision: true,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    contextWindowTokens: 200_000,
    usageReporting: true,
    costReporting: true,
    models: [],
    reasoningControl: true,
  },
  providerRouting: true,
  usageRequest: 'openrouter',
  envelope: null,
  headers: (appUrl) => ({ 'HTTP-Referer': appUrl, 'X-Title': 'eXocortex' }),
};

/**
 * OpenRouter adapter.
 *
 * `AI_PROVIDER=mock` is still the default; this only runs when explicitly
 * selected. The transport itself is shared with every other Chat Completions
 * endpoint (issue #187); what is OpenRouter's own is the dialect above.
 */
export class OpenRouterProvider extends ChatCompletionsProvider {
  constructor(options: OpenRouterProviderOptions) {
    super(OPENROUTER_DIALECT, options);
  }
}
