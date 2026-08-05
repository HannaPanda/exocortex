import { type AiUsage } from '@exocortex/contracts';

import {
  AI_DEFAULT_LIMITS,
  AiCancelledError,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProvider,
  type AiProviderCapabilities,
  type AiStreamEvent,
} from './provider';

export interface MockProviderOptions {
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
  /** Overrides the generated answer; useful in tests. */
  fixedResponse?: string;
  model?: string;
}

const MOCK_CAPABILITIES: AiProviderCapabilities = {
  textGeneration: true,
  vision: false,
  toolCalling: false,
  structuredOutput: false,
  streaming: true,
  contextWindowTokens: 32_000,
  usageReporting: true,
  costReporting: true,
  models: ['exocortex-mock-1'],
};

function estimateTokens(text: string): number {
  // Rough but deterministic: four characters per token.
  return Math.max(1, Math.ceil(text.length / 4));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic mock provider.
 *
 * Used by the AI side panel in this version of Exocortex: it streams a German
 * answer through the real realtime infrastructure without contacting any
 * external service, so the streaming path is fully exercised end to end.
 */
export class MockAiProvider implements AiProvider {
  public readonly id = 'mock';
  public readonly capabilities = MOCK_CAPABILITIES;

  private readonly chunkDelayMs: number;
  private readonly fixedResponse: string | undefined;
  private readonly model: string;

  constructor(options: MockProviderOptions = {}) {
    this.chunkDelayMs = options.chunkDelayMs ?? 40;
    this.fixedResponse = options.fixedResponse;
    this.model = options.model ?? 'exocortex-mock-1';
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startedAt = Date.now();
    const text = this.buildResponse(request);
    return {
      text,
      finishReason: 'stop',
      usage: this.buildUsage(request, text, Date.now() - startedAt),
    };
  }

  async *stream(request: AiGenerateRequest): AsyncIterable<AiStreamEvent> {
    const startedAt = Date.now();
    yield { type: 'start', model: this.model, provider: this.id };

    const text = this.buildResponse(request);
    const chunks = text.match(/\S+\s*/g) ?? [text];
    let sequence = 0;
    let emitted = '';

    for (const chunk of chunks) {
      if (request.signal?.aborted === true) {
        yield { type: 'error', code: 'ai_cancelled', message: 'AI run was cancelled' };
        return;
      }
      try {
        await sleep(this.chunkDelayMs, request.signal);
      } catch {
        yield { type: 'error', code: 'ai_cancelled', message: 'AI run was cancelled' };
        return;
      }
      emitted += chunk;
      sequence += 1;
      yield { type: 'delta', text: chunk, sequence };
    }

    yield { type: 'usage', usage: this.buildUsage(request, emitted, Date.now() - startedAt) };
    yield { type: 'done', text: emitted, finishReason: 'stop' };
  }

  private buildResponse(request: AiGenerateRequest): string {
    if (this.fixedResponse !== undefined) return this.fixedResponse;

    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === 'user');
    const question = lastUserMessage?.content.trim() ?? '';
    const shortened = question.length > 160 ? `${question.slice(0, 157)}...` : question;

    return [
      'Hier ist eine Beispielantwort des Mock-Anbieters.',
      '',
      `Deine Frage war: „${shortened}“`,
      '',
      'In dieser Version von Exocortex ist absichtlich kein externer KI-Anbieter',
      'angebunden. Die Antwort wird aber über dieselbe Streaming-Infrastruktur',
      'ausgeliefert wie später echte Modelle: Der Worker erzeugt die Teilstücke,',
      'die API verteilt sie über den Anwendungs-WebSocket und das Panel rendert',
      'sie fortlaufend.',
    ].join('\n');
  }

  private buildUsage(request: AiGenerateRequest, output: string, durationMs: number): AiUsage {
    const inputTokens = request.messages.reduce(
      (total, message) => total + estimateTokens(message.content),
      0,
    );
    const outputTokens = estimateTokens(output);
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      provider: this.id,
      model: request.model ?? this.model,
      // The mock provider is free, but it still reports the field so the UI and
      // the database path are exercised.
      providerCostMicroUsd: 0,
      durationMs: Math.max(durationMs, 1),
    };
  }

  /** Exposes the configured limits so callers can display them. */
  static get defaultLimits(): typeof AI_DEFAULT_LIMITS {
    return AI_DEFAULT_LIMITS;
  }
}
