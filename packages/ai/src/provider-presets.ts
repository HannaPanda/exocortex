import { type ChatCompletionsDialect } from './chat-completions-provider';

/**
 * A subscription or alternative endpoint, checked by hand before it is listed
 * here (issue #187).
 *
 * A preset is data, not a class: a fixed HTTPS address, the dialect its
 * answers come in, and the OpenRouter model each of its models corresponds to.
 * The address is never taken from a request or a setting, so a key can only
 * ever travel to the host it was issued by. What a plan costs, how large its
 * quota is and which terms it has are dated facts and live in the Brain page
 * of #187, never in code.
 */
export interface ProviderPreset {
  dialect: ChatCompletionsDialect;
  baseUrl: string;
  /**
   * The OpenRouter slug that serves the same model, for the opt-in fallback
   * (`ai.subscriptionFallback`). A model missing here has no fallback: the
   * run then fails like any other provider refusal.
   */
  openRouterEquivalents: Readonly<Record<string, string>>;
}

/**
 * Cline Pass, measured 2026-10-12: DeepSeek V4.1 Flash served by DeepSeek
 * itself, about 145 tokens/s, cache reads reported and billed at the cache
 * price. Its terms allow scripts, apps and automation explicitly. A streamed
 * answer is plain OpenAI SSE with usage on request; an unstreamed one comes
 * wrapped in `{ "data": …, "success": true }`.
 */
const CLINE: ProviderPreset = {
  dialect: {
    id: 'cline',
    label: 'Cline',
    keyName: 'CLINE_API_KEY',
    capabilities: {
      textGeneration: true,
      vision: false,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      contextWindowTokens: 200_000,
      usageReporting: true,
      costReporting: true,
      models: [],
      reasoningControl: true,
    },
    providerRouting: false,
    usageRequest: 'stream-options',
    envelope: 'data',
    headers: () => ({}),
  },
  baseUrl: 'https://api.cline.bot/api/v1',
  openRouterEquivalents: {
    'cline-pass/deepseek-v4.1-flash': 'deepseek/deepseek-v4.1-flash',
  },
};

export const PROVIDER_PRESETS = { cline: CLINE } as const;

export type ProviderPresetId = keyof typeof PROVIDER_PRESETS;

export function isProviderPresetId(value: string): value is ProviderPresetId {
  return Object.hasOwn(PROVIDER_PRESETS, value);
}
