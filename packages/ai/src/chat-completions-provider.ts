import { z } from 'zod';

import { type AiUsage, mergeProviderRouting, type ProviderRouting } from '@exocortex/contracts';
import { type Logger, withSpan } from '@exocortex/logger';

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

/**
 * What sets one Chat Completions endpoint apart from another (issue #187).
 *
 * The wire format is OpenAI's everywhere; what differs is small and declared
 * here rather than in a subclass per vendor: how the answer is wrapped, how
 * usage is asked for, and whether OpenRouter's routing object exists at all.
 * A vendor whose protocol differs beyond these fields gets an adapter of its
 * own, not another flag.
 */
export interface ChatCompletionsDialect {
  /** `AiProvider.id`, and the value of `AiModel.provider` that selects it. */
  id: string;
  /** The vendor's name in error messages. */
  label: string;
  /** The environment variable the key comes from, named when it is missing. */
  keyName: string;
  capabilities: AiProviderCapabilities;
  /**
   * Whether the endpoint understands OpenRouter's `provider` object (ADR-032,
   * ADR-063) and answers an unsatisfiable `only` with a 404. Off means neither
   * is sent nor interpreted: routing keys are OpenRouter's vocabulary.
   */
  providerRouting: boolean;
  /**
   * How usage is requested: OpenRouter's `usage.include`, or the OpenAI
   * `stream_options.include_usage` on a stream.
   */
  usageRequest: 'openrouter' | 'stream-options';
  /** The key a non-streamed answer is wrapped in (`{ "data": … }`), or null for none. */
  envelope: string | null;
  /** Headers beside authorization and content type. */
  headers: (appUrl: string) => Record<string, string>;
}

export interface ChatCompletionsProviderOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  logger: Logger;
  /** Public application URL, sent as `HTTP-Referer` as OpenRouter recommends. */
  appUrl: string;
  /**
   * The provider preferences in force for one model: the setting
   * `ai.providerRouting` with that model's override laid over it (issue #135,
   * ADR-063). Asked once per request, so it applies to every caller of this
   * adapter rather than to the ones that remembered to pass it. Absent means
   * no preferences, which is how every request went out before it existed.
   * Ignored by a dialect without `providerRouting`.
   */
  providerRoutingFor?: (model: string) => Promise<ProviderRouting>;
}

/** Shape of an assistant `toolCalls` field once it round-trips through the contract's `unknown`. */
const assistantToolCallsSchema = z.array(
  z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  }),
);

/**
 * The error code for a request no allowed provider could serve.
 *
 * OpenRouter answers a `provider.only` list it cannot satisfy with a 404 and a
 * message naming the providers it does have. That is a routing outcome, not an
 * outage, and the caller can do something about it (compact and re-plan), so it
 * must not arrive as the same `ai_provider_unavailable` as a dead upstream.
 */
export const AI_NO_ELIGIBLE_PROVIDER = 'ai_no_eligible_provider';

/** Whether a failed response is OpenRouter refusing the allowlist rather than failing. */
function isRoutingRefusal(
  dialect: ChatCompletionsDialect,
  status: number,
  request: AiGenerateRequest,
): boolean {
  return (
    dialect.providerRouting &&
    status === 404 &&
    (request.routing?.allowedProviderKeys?.length ?? 0) > 0
  );
}

function mapFinishReason(raw: string | undefined): AiGenerateResult['finishReason'] {
  if (raw === 'tool_calls' || raw === 'stop' || raw === 'length' || raw === 'content_filter') {
    return raw;
  }
  return 'stop';
}

/**
 * One OpenAI-shaped Chat Completions endpoint (issue #187).
 *
 * OpenRouter is one dialect of it (`OpenRouterProvider`), a subscription
 * endpoint such as Cline Pass another (`provider-presets.ts`). Every method
 * refuses to run unless an API key is configured, so it can never silently
 * start making paid calls. The messages a user typed are the only per-request
 * content; document images may additionally reach a configured vision model as
 * a separate preprocessing step (ADR-012), never through this class (see
 * docs/ai-architecture.md).
 */
export class ChatCompletionsProvider implements AiProvider {
  public readonly id: string;
  public readonly capabilities: AiProviderCapabilities;

  private readonly options: ChatCompletionsProviderOptions;
  private readonly dialect: ChatCompletionsDialect;

  constructor(dialect: ChatCompletionsDialect, options: ChatCompletionsProviderOptions) {
    this.dialect = dialect;
    this.options = options;
    this.id = dialect.id;
    this.capabilities = dialect.capabilities;
  }

  private assertConfigured(): void {
    if (this.options.apiKey.length === 0) {
      throw new AiProviderError(
        'ai_provider_unavailable',
        `${this.dialect.label} is selected but ${this.dialect.keyName} is empty. Set the key or use AI_PROVIDER=mock.`,
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
        const parsed = assistantToolCallsSchema.safeParse(message.toolCalls);
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

  private modelOf(request: AiGenerateRequest): string {
    return request.model ?? this.options.defaultModel ?? 'anthropic/claude-sonnet-4.5';
  }

  /**
   * The configured preferences for this request's model, or none.
   *
   * A lookup that fails is logged and costs the request its preferences, never
   * the request itself: a model that answered yesterday must not stop
   * answering because a settings read timed out.
   */
  private async preferencesFor(request: AiGenerateRequest): Promise<ProviderRouting> {
    const configured = await this.configuredPreferencesFor(request);
    // An agent profile's keys go on top (issue #143), the same way a model's
    // override goes on top of the global object.
    const own = request.routing?.preferences;
    return own === undefined ? configured : mergeProviderRouting(configured, own);
  }

  private async configuredPreferencesFor(request: AiGenerateRequest): Promise<ProviderRouting> {
    if (this.options.providerRoutingFor === undefined) return {};
    try {
      return await this.options.providerRoutingFor(this.modelOf(request));
    } catch (error) {
      this.options.logger.warn('Provider preferences unavailable; sending none', {
        correlationId: request.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * The request's `provider` object, or `undefined` for none (ADR-032, ADR-063).
   *
   * Two sources, with separate jobs. The configuration says how to choose
   * (`sort`, `ignore`, and anything else OpenRouter accepts), verbatim. The
   * plan says who *can* serve this prompt, and where there is one its list
   * replaces a configured `only`: the plan was computed from endpoints the
   * configuration had already narrowed, so it is the same list minus the
   * providers too small for this turn. `allow_fallbacks` stays on unless the
   * configuration says otherwise, so failover between the eligible providers
   * keeps working.
   */
  private providerField(
    request: AiGenerateRequest,
    preferences: ProviderRouting,
  ): Record<string, unknown> | undefined {
    const allowed = request.routing?.allowedProviderKeys ?? [];
    const field: Record<string, unknown> = { ...preferences };
    if (allowed.length > 0) {
      field.only = [...allowed];
      field.allow_fallbacks = preferences.allow_fallbacks ?? true;
    }
    return Object.keys(field).length === 0 ? undefined : field;
  }

  private async buildBody(request: AiGenerateRequest, stream: boolean): Promise<string> {
    const preferences = this.dialect.providerRouting ? await this.preferencesFor(request) : {};
    const provider = this.dialect.providerRouting
      ? this.providerField(request, preferences)
      : undefined;
    // Configured preferences are logged per request, so which routing a run
    // actually asked for can be read beside OpenRouter's own activity log. A
    // plan alone is already recorded by the worker at debug level.
    if (provider !== undefined && Object.keys(preferences).length > 0) {
      this.options.logger.info('OpenRouter provider preferences for request', {
        correlationId: request.correlationId,
        model: this.modelOf(request),
        provider,
      });
    }
    return JSON.stringify({
      model: this.modelOf(request),
      messages: this.mapMessages(request),
      max_tokens: request.maxOutputTokens ?? AI_DEFAULT_LIMITS.maxOutputTokens,
      temperature: request.temperature ?? 0.3,
      stream,
      ...this.usageRequestField(stream),
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
      ...(provider === undefined ? {} : { provider }),
    });
  }

  private usageRequestField(stream: boolean): Record<string, unknown> {
    if (this.dialect.usageRequest === 'openrouter') return { usage: { include: true } };
    return stream ? { stream_options: { include_usage: true } } : {};
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
      ...this.dialect.headers(this.options.appUrl),
    };
  }

  /**
   * The request to the endpoint, with the span that measures it (issue #57).
   *
   * Only up to the response headers on purpose: for a streamed answer the rest
   * of the time is the model writing, and that is what the `ai.turn` span
   * above already measures. What this one adds is the part nobody can see from
   * the outside -- how long the provider took to say anything at all, and what
   * it answered when it refused.
   */
  private async postCompletions(request: AiGenerateRequest, streaming: boolean): Promise<Response> {
    return withSpan(
      'ai.provider.request',
      async (span) => {
        const response = await fetch(`${this.options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: await this.buildBody(request, streaming),
          signal: request.signal ?? null,
        });
        span.setAttribute('http.response.status_code', response.status);
        if (!response.ok) span.setStatus('error', `http_${response.status}`);
        return response;
      },
      {
        kind: 'client',
        correlationId: request.correlationId,
        attributes: {
          'ai.provider': this.id,
          'ai.model': request.model ?? this.options.defaultModel,
          'ai.stream': streaming,
        },
      },
    );
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.assertConfigured();
    const startedAt = Date.now();
    const response = await this.postCompletions(request, false);

    if (!response.ok) {
      const detail = await response.text();
      this.options.logger.error(`${this.dialect.label} request failed`, undefined, {
        status: response.status,
        correlationId: request.correlationId,
      });
      throw new AiProviderError(
        isRoutingRefusal(this.dialect, response.status, request)
          ? AI_NO_ELIGIBLE_PROVIDER
          : 'ai_provider_unavailable',
        `${this.dialect.label} responded with ${response.status}: ${detail.slice(0, 200)}`,
        { status: response.status },
      );
    }

    const payload = this.unwrap(await response.json());
    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? '';
    const toolCalls: AiToolCall[] = (message?.tool_calls ?? [])
      .filter(
        (call): call is CompletionToolCall & { function: { name: string; arguments: string } } =>
          call.function?.name !== undefined && call.function.arguments !== undefined,
      )
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        argumentsJson: call.function.arguments,
      }));

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
    yield { type: 'start', model: this.modelOf(request), provider: this.id };

    const response = await this.postCompletions(request, true);

    if (!response.ok || response.body === null) {
      yield {
        type: 'error',
        code: isRoutingRefusal(this.dialect, response.status, request)
          ? AI_NO_ELIGIBLE_PROVIDER
          : 'ai_provider_unavailable',
        message: `${this.dialect.label} responded with ${response.status}`,
        status: response.status,
      };
      return;
    }

    const state: StreamState = {
      text: '',
      sequence: 0,
      usage: null,
      firstTokenAt: null,
      finishReason: 'stop',
      /**
       * Tool calls arrive as fragments: the first chunk for an index carries
       * `id` and `function.name`, later chunks append to `function.arguments`.
       * Accumulating by index is the only correct way to reassemble them.
       */
      partialToolCalls: new Map<number, PartialToolCall>(),
    };

    for await (const chunk of this.readStreamChunks(response.body, request.correlationId)) {
      yield* this.consumeChunk(chunk, state, request, startedAt);
    }

    let toolCalls: AiToolCall[] = [];
    if (state.partialToolCalls.size > 0) {
      toolCalls = [...state.partialToolCalls.entries()]
        .sort(([indexA], [indexB]) => indexA - indexB)
        .map(([, call]) => ({ id: call.id, name: call.name, argumentsJson: call.args }));
      yield { type: 'tool_calls', toolCalls };
    }

    if (state.usage !== null) yield { type: 'usage', usage: state.usage };
    // 'length' must survive: a run that hit the output cap mid-arguments also
    // carries half-assembled tool calls, and reporting those as a clean
    // 'tool_calls' finish is exactly what made truncation invisible before.
    yield {
      type: 'done',
      text: state.text,
      finishReason:
        toolCalls.length > 0 && state.finishReason !== 'length' ? 'tool_calls' : state.finishReason,
    };
  }

  /**
   * Yields the parsed payload of every `data:` line in a server-sent event body.
   *
   * The network decides where a chunk ends, not the protocol, so a `data:` line
   * routinely arrives in pieces; only whole lines are handed on. A payload that
   * is not valid JSON is logged and skipped rather than ending the stream: one
   * broken frame must not cost the answer that came before it.
   */
  private async *readStreamChunks(
    body: ReadableStream<Uint8Array>,
    correlationId: string | undefined,
  ): AsyncGenerator<CompletionStreamChunk> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = '';

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
        try {
          yield JSON.parse(data) as CompletionStreamChunk;
        } catch (error) {
          this.options.logger.warn(`Skipping malformed ${this.dialect.label} stream chunk`, {
            correlationId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Folds one chunk into the running state and returns what to emit for it. */
  private consumeChunk(
    chunk: CompletionStreamChunk,
    state: StreamState,
    request: AiGenerateRequest,
    startedAt: number,
  ): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    // The first sign of an answer, thinking included: what a person waits
    // through before anything moves, and the half of a slow provider that the
    // total duration hides (issue #187).
    if (
      state.firstTokenAt === null &&
      (Boolean(delta?.content) || Boolean(delta?.reasoning) || delta?.tool_calls !== undefined)
    ) {
      state.firstTokenAt = Date.now();
    }

    // Reasoning *text* is still deliberately dropped: it is not the answer
    // and would corrupt `resultText`. Only its size is passed on, so a
    // client can tell "the model is thinking" apart from "nothing is
    // happening" without the thinking itself leaving this adapter.
    if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
      events.push({ type: 'reasoning', charCount: delta.reasoning.length });
    }
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      state.text += delta.content;
      state.sequence += 1;
      events.push({ type: 'delta', text: delta.content, sequence: state.sequence });
    }
    if (delta?.tool_calls !== undefined) {
      mergeToolCallDeltas(state.partialToolCalls, delta.tool_calls);
    }
    if (choice?.finish_reason !== undefined) {
      state.finishReason = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage !== undefined) {
      state.usage = this.mapUsage(
        { usage: chunk.usage, model: chunk.model, provider: chunk.provider },
        request,
        Date.now() - startedAt,
        state.firstTokenAt === null ? null : state.firstTokenAt - startedAt,
      );
    }
    return events;
  }

  /**
   * The completion inside the dialect's envelope. Checked rather than cast: a
   * body without the envelope is taken as it is, because an endpoint that
   * stops wrapping must not turn every answer into an empty one.
   */
  private unwrap(body: unknown): Completion {
    const key = this.dialect.envelope;
    if (key !== null && typeof body === 'object' && body !== null && key in body) {
      return (body as Record<string, unknown>)[key] as Completion;
    }
    return body as Completion;
  }

  private mapUsage(
    payload: { usage?: CompletionUsage; model?: string; provider?: string },
    request: AiGenerateRequest,
    durationMs: number,
    firstTokenMs: number | null = null,
  ): AiUsage {
    return {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      provider: this.id,
      servedBy:
        typeof payload.provider === 'string' && payload.provider.length > 0
          ? payload.provider
          : null,
      model: payload.model ?? request.model ?? 'unknown',
      providerCostMicroUsd:
        payload.usage?.cost === undefined ? null : Math.round(payload.usage.cost * 1_000_000),
      durationMs,
      ...(firstTokenMs === null ? {} : { firstTokenMs }),
    };
  }
}

interface CompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface CompletionToolCall {
  id: string;
  type: string;
  function?: { name?: string; arguments?: string };
}

interface Completion {
  model?: string;
  /** The upstream provider that served the request, e.g. `DeepInfra`. */
  provider?: string;
  usage?: CompletionUsage;
  choices?: {
    message?: { content?: string; tool_calls?: CompletionToolCall[] };
    finish_reason?: string;
  }[];
}

interface CompletionStreamChunk {
  model?: string;
  provider?: string;
  usage?: CompletionUsage;
  choices?: {
    delta?: {
      content?: string;
      reasoning?: string;
      tool_calls?: CompletionToolCallDelta[];
    };
    finish_reason?: string;
  }[];
}

interface CompletionToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Everything a stream accumulates across chunks before it can report a result. */
interface StreamState {
  text: string;
  sequence: number;
  usage: AiUsage | null;
  /** `Date.now()` when the first content, reasoning or tool-call fragment arrived. */
  firstTokenAt: number | null;
  finishReason: AiGenerateResult['finishReason'];
  partialToolCalls: Map<number, PartialToolCall>;
}

/** One tool call under construction, assembled from the fragments of a stream. */
interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Merges the tool-call fragments of a single stream chunk into the accumulator.
 *
 * The first chunk for an index carries `id` and `function.name`, later chunks
 * append to `function.arguments`, so accumulating by index is the only correct
 * way to reassemble them. Kept out of the stream loop because the merge is
 * three independent field updates and reads better without four levels of
 * surrounding control flow.
 */
function mergeToolCallDeltas(
  partialToolCalls: Map<number, PartialToolCall>,
  deltas: readonly CompletionToolCallDelta[],
): void {
  for (const delta of deltas) {
    const existing = partialToolCalls.get(delta.index) ?? { id: '', name: '', args: '' };
    if (delta.id !== undefined) existing.id = delta.id;
    if (delta.function?.name !== undefined) existing.name = delta.function.name;
    if (delta.function?.arguments !== undefined) existing.args += delta.function.arguments;
    partialToolCalls.set(delta.index, existing);
  }
}
