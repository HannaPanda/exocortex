import { type AiUsage } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import {
  AI_DEFAULT_LIMITS,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type AiProviderCapabilities,
  AiProviderError,
  type AiStreamEvent,
} from './provider';

export interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  logger: Logger;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
}

const OPENROUTER_CAPABILITIES: AiProviderCapabilities = {
  textGeneration: true,
  vision: true,
  toolCalling: true,
  structuredOutput: true,
  streaming: true,
  contextWindowTokens: 200_000,
  usageReporting: true,
  costReporting: true,
  models: [],
};

/**
 * OpenRouter adapter.
 *
 * `AI_PROVIDER=mock` is still the default; this only runs when explicitly
 * selected. Every method refuses to run unless an API key is configured, so it
 * can never silently start making paid calls. The messages a user typed are
 * the only per-request content; document images may additionally reach a
 * configured vision model as a separate preprocessing step (ADR-012), never
 * through this class (see docs/ai-architecture.md).
 */
export class OpenRouterProvider implements AiProvider {
  public readonly id = 'openrouter';
  public readonly capabilities = OPENROUTER_CAPABILITIES;

  private readonly options: OpenRouterProviderOptions;

  constructor(options: OpenRouterProviderOptions) {
    this.options = options;
  }

  private assertConfigured(): void {
    if (this.options.apiKey.length === 0) {
      throw new AiProviderError(
        'ai_provider_unavailable',
        'OpenRouter is selected but OPENROUTER_API_KEY is empty. Set the key or use AI_PROVIDER=mock.',
      );
    }
  }

  private buildBody(request: AiGenerateRequest, stream: boolean): string {
    return JSON.stringify({
      model: request.model ?? this.options.defaultModel ?? 'anthropic/claude-sonnet-4.5',
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      max_tokens: request.maxOutputTokens ?? AI_DEFAULT_LIMITS.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      stream,
      usage: { include: true },
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.options.appUrl,
      'X-Title': 'Exocortex',
    };
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(request, false),
      signal: request.signal ?? null,
    });

    if (!response.ok) {
      const detail = await response.text();
      this.options.logger.error('OpenRouter request failed', undefined, {
        status: response.status,
        correlationId: request.correlationId,
      });
      throw new AiProviderError(
        'ai_provider_unavailable',
        `OpenRouter responded with ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as OpenRouterCompletion;
    const text = payload.choices?.[0]?.message?.content ?? '';
    return {
      text,
      finishReason: 'stop',
      usage: this.mapUsage(payload, request, Date.now() - startedAt),
    };
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    this.assertConfigured();
    const startedAt = Date.now();
    const model = request.model ?? this.options.defaultModel ?? 'anthropic/claude-sonnet-4.5';
    yield { type: 'start', model, provider: this.id };

    const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(request, true),
      signal: request.signal ?? null,
    });

    if (!response.ok || response.body === null) {
      yield {
        type: 'error',
        code: 'ai_provider_unavailable',
        message: `OpenRouter responded with ${response.status}`,
      };
      return;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let text = '';
    let sequence = 0;
    let usage: AiUsage | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: OpenRouterStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenRouterStreamChunk;
        } catch (error) {
          this.options.logger.warn('Skipping malformed OpenRouter stream chunk', {
            correlationId: request.correlationId,
            reason: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          text += delta;
          sequence += 1;
          yield { type: 'delta', text: delta, sequence };
        }
        if (chunk.usage !== undefined) {
          usage = this.mapUsage({ usage: chunk.usage, model: chunk.model }, request, Date.now() - startedAt);
        }
      }
    }

    if (usage !== null) yield { type: 'usage', usage };
    yield { type: 'done', text, finishReason: 'stop' };
  }

  private mapUsage(
    payload: { usage?: OpenRouterUsage; model?: string },
    request: AiGenerateRequest,
    durationMs: number,
  ): AiUsage {
    return {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      provider: this.id,
      model: payload.model ?? request.model ?? 'unknown',
      providerCostMicroUsd:
        payload.usage?.cost === undefined ? null : Math.round(payload.usage.cost * 1_000_000),
      durationMs,
    };
  }
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenRouterCompletion {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: { message?: { content?: string } }[];
}

interface OpenRouterStreamChunk {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: { delta?: { content?: string } }[];
}
