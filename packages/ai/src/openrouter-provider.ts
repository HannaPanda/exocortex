import { z } from 'zod';

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
  type AiToolCall,
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
  reasoningControl: true,
};

/** Shape of an assistant `toolCalls` field once it round-trips through the contract's `unknown`. */
const openRouterToolCallsSchema = z.array(
  z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  }),
);

function mapFinishReason(raw: string | undefined): AiGenerateResult['finishReason'] {
  if (raw === 'tool_calls' || raw === 'stop' || raw === 'length' || raw === 'content_filter') {
    return raw;
  }
  return 'stop';
}

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

  /**
   * Maps contract messages onto the OpenAI-shaped wire format. Tool turns need
   * extra fields the base `{ role, content }` shape does not carry.
   * `toolCalls` arrives as `unknown` (it is provider-shaped and only passed
   * through by the contract), so it is parsed defensively: a malformed value
   * is dropped with a warning rather than sent upstream or cast away.
   */
  private mapMessages(request: AiGenerateRequest): unknown[] {
    return request.messages.map((message) => {
      if (message.role === 'tool') {
        return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
      }
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        const parsed = openRouterToolCallsSchema.safeParse(message.toolCalls);
        if (parsed.success) {
          return { role: 'assistant', content: message.content, tool_calls: parsed.data };
        }
        this.options.logger.warn('Dropping malformed assistant tool_calls', {
          correlationId: request.correlationId,
          issues: parsed.error.issues.map((issue) => issue.path.join('.')),
        });
      }
      return { role: message.role, content: message.content };
    });
  }

  private buildBody(request: AiGenerateRequest, stream: boolean): string {
    return JSON.stringify({
      model: request.model ?? this.options.defaultModel ?? 'anthropic/claude-sonnet-4.5',
      messages: this.mapMessages(request),
      max_tokens: request.maxOutputTokens ?? AI_DEFAULT_LIMITS.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      stream,
      usage: { include: true },
      ...(request.tools === undefined || request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: request.toolChoice ?? 'auto',
          }),
      ...(request.reasoning === undefined || request.reasoning.effort === 'none'
        ? {}
        : { reasoning: { effort: request.reasoning.effort } }),
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
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? '';
    const toolCalls: AiToolCall[] = (message?.tool_calls ?? [])
      .filter(
        (call): call is OpenRouterToolCallResponse & { function: { name: string; arguments: string } } =>
          call.function?.name !== undefined && call.function.arguments !== undefined,
      )
      .map((call) => ({ id: call.id, name: call.function.name, argumentsJson: call.function.arguments }));

    return {
      text,
      finishReason: mapFinishReason(payload.choices?.[0]?.finish_reason),
      usage: this.mapUsage(payload, request, Date.now() - startedAt),
      toolCalls,
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
    let lastFinishReason: AiGenerateResult['finishReason'] = 'stop';
    /**
     * Tool calls arrive as fragments: the first chunk for an index carries `id`
     * and `function.name`, later chunks append to `function.arguments`.
     * Accumulating by index is the only correct way to reassemble them.
     */
    const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();

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
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        // Reasoning *text* is still deliberately dropped: it is not the answer
        // and would corrupt `resultText`. Only its size is passed on, so a
        // client can tell "the model is thinking" apart from "nothing is
        // happening" without the thinking itself leaving this adapter.
        if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
          yield { type: 'reasoning', charCount: delta.reasoning.length };
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          sequence += 1;
          yield { type: 'delta', text: delta.content, sequence };
        }
        if (delta?.tool_calls !== undefined) {
          for (const toolCallDelta of delta.tool_calls) {
            const existing = partialToolCalls.get(toolCallDelta.index) ?? {
              id: '',
              name: '',
              args: '',
            };
            if (toolCallDelta.id !== undefined) existing.id = toolCallDelta.id;
            if (toolCallDelta.function?.name !== undefined) existing.name = toolCallDelta.function.name;
            if (toolCallDelta.function?.arguments !== undefined) {
              existing.args += toolCallDelta.function.arguments;
            }
            partialToolCalls.set(toolCallDelta.index, existing);
          }
        }
        if (choice?.finish_reason !== undefined) {
          lastFinishReason = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined) {
          usage = this.mapUsage({ usage: chunk.usage, model: chunk.model }, request, Date.now() - startedAt);
        }
      }
    }

    let toolCalls: AiToolCall[] = [];
    if (partialToolCalls.size > 0) {
      toolCalls = [...partialToolCalls.entries()]
        .sort(([indexA], [indexB]) => indexA - indexB)
        .map(([, call]) => ({ id: call.id, name: call.name, argumentsJson: call.args }));
      yield { type: 'tool_calls', toolCalls };
    }

    if (usage !== null) yield { type: 'usage', usage };
    // 'length' must survive: a run that hit the output cap mid-arguments also
    // carries half-assembled tool calls, and reporting those as a clean
    // 'tool_calls' finish is exactly what made truncation invisible before.
    yield {
      type: 'done',
      text,
      finishReason: toolCalls.length > 0 && lastFinishReason !== 'length' ? 'tool_calls' : lastFinishReason,
    };
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

interface OpenRouterToolCallResponse {
  id: string;
  type: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterCompletion {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: {
    message?: { content?: string; tool_calls?: OpenRouterToolCallResponse[] };
    finish_reason?: string;
  }[];
}

interface OpenRouterStreamChunk {
  model?: string;
  usage?: OpenRouterUsage;
  choices?: {
    delta?: {
      content?: string;
      reasoning?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
}
