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

export interface AiReasoningOptions {
  /** OpenRouter `reasoning.effort`. Omitted entirely for 'none'. */
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
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

/** Default limits applied when a caller does not specify them. */
export const AI_DEFAULT_LIMITS = {
  timeoutMs: 60_000,
  maxOutputTokens: 2_048,
  budgetMicroUsd: 50_000,
} as const;
