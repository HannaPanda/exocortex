import { type AiMessage, type AiUsage } from '@exocortex/contracts';

/**
 * Provider-neutral AI contract.
 *
 * Nothing in the application depends on OpenRouter, Anthropic or OpenAI: services
 * talk to `AiProvider` only. Adding a provider means implementing this interface
 * and registering it (see docs/ai-architecture.md).
 */

export interface AiProviderCapabilities {
  textGeneration: boolean;
  vision: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  /** Context window in tokens of the default model. */
  contextWindowTokens: number;
  usageReporting: boolean;
  /** Provider reports the cost of a request. */
  costReporting: boolean;
  /** Models the provider exposes. Empty means "provider decides". */
  models: readonly string[];
  /** Provider accepts an explicit `reasoning.effort` control. */
  reasoningControl: boolean;
}

/** One tool the model may call, in provider-neutral form. */
export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12) of the tool's arguments. */
  parameters: unknown;
}

/** A tool call the model asked for. */
export interface AiToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string as the model produced it. Parsed by the caller,
   *  because a model can emit invalid JSON and the caller must report that back
   *  as a tool result rather than crashing the run. */
  argumentsJson: string;
}

/**
 * Technical requirements this request places on whoever serves it (ADR-032).
 *
 * Provider-neutral on purpose: a caller says what the request needs and which
 * providers may serve it, and the adapter for a provider that can route
 * translates that into its own wire format. A caller never builds a provider's
 * routing object itself.
 */
export interface AiRoutingRequirements {
  /** Minimum total context window this request needs, for diagnostics and adapters that can ask for it. */
  minimumContextTokens?: number;
  /**
   * Opaque provider keys that may serve this request, as the model registry's
   * endpoint snapshot named them. An empty or absent list means "no preference":
   * the provider routes as it normally would.
   */
  allowedProviderKeys?: readonly string[];
}

export interface AiReasoningOptions {
  /** OpenRouter `reasoning.effort`. Omitted entirely for 'none'. */
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface AiGenerateRequest {
  messages: readonly AiMessage[];
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Aborts the request; providers must honour it. */
  signal?: AbortSignal;
  /** Hard timeout in milliseconds. */
  timeoutMs?: number;
  /** Cost ceiling in micro-USD. A provider must refuse to exceed it. */
  budgetMicroUsd?: number;
  correlationId: string;
  tools?: readonly AiToolDefinition[];
  /** 'auto' lets the model decide, 'none' forbids calls. Default 'auto' when
   *  tools are present. */
  toolChoice?: 'auto' | 'none';
  reasoning?: AiReasoningOptions;
  /** What this request needs from whoever serves it (ADR-032). Ignored by providers that cannot route. */
  routing?: AiRoutingRequirements;
}

export interface AiGenerateResult {
  text: string;
  usage: AiUsage;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'cancelled' | 'error';
  toolCalls: readonly AiToolCall[];
}

export type AiStreamEvent =
  | { type: 'start'; model: string; provider: string }
  | { type: 'delta'; text: string; sequence: number }
  /**
   * The model is thinking. Carries the size of the reasoning fragment, never
   * the fragment itself: reasoning is the model's private working-out, it is
   * not the answer, and putting it on an event bus or in a log would spill it
   * into places the user never asked for. Consumers use this to say that a
   * silence is thinking rather than a stall (issue #6).
   */
  | { type: 'reasoning'; charCount: number }
  | { type: 'tool_calls'; toolCalls: readonly AiToolCall[] }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'done'; text: string; finishReason: AiGenerateResult['finishReason'] }
  | { type: 'error'; code: string; message: string };

export interface AiProvider {
  readonly id: string;
  readonly capabilities: AiProviderCapabilities;
  generate(request: AiGenerateRequest): Promise<AiGenerateResult>;
  stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent>;
}

export class AiProviderError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiProviderError';
    this.code = code;
  }
}

export class AiCancelledError extends AiProviderError {
  constructor(message = 'AI run was cancelled') {
    super('ai_cancelled', message);
    this.name = 'AiCancelledError';
  }
}

export class AiTimeoutError extends AiProviderError {
  constructor(timeoutMs: number) {
    super('ai_timeout', `AI run exceeded its timeout of ${timeoutMs}ms`);
    this.name = 'AiTimeoutError';
  }
}

export class AiBudgetExceededError extends AiProviderError {
  constructor(budgetMicroUsd: number) {
    super('ai_budget_exceeded', `AI run would exceed its budget of ${budgetMicroUsd} micro-USD`);
    this.name = 'AiBudgetExceededError';
  }
}

/**
 * Default limits applied when a caller does not specify them.
 *
 * `maxOutputTokens` matches the default of the `ai.maxOutputTokens` setting on
 * purpose: an agent that writes a page through a tool call needs the arguments
 * of that call to fit in one answer, and 2048 tokens truncated real writes
 * mid-argument. Callers that know they need less (the compaction summary, an
 * image description) still pass their own, smaller limit.
 */
export const AI_DEFAULT_LIMITS = {
  timeoutMs: 60_000,
  maxOutputTokens: 4_096,
  budgetMicroUsd: 50_000,
} as const;
