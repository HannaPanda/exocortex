import { describe, expect, it } from 'vitest';

import { MockAiProvider } from './mock-provider';
import { type AiStreamEvent } from './provider';
import { createAiProvider } from './registry';

const request = {
  messages: [{ role: 'user' as const, content: 'Was ist Exocortex?' }],
  correlationId: 'corr-test',
};

async function collect(provider: MockAiProvider): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

describe('MockAiProvider', () => {
  it('declares streaming and usage reporting capabilities', () => {
    const provider = new MockAiProvider();
    expect(provider.capabilities.streaming).toBe(true);
    expect(provider.capabilities.usageReporting).toBe(true);
    expect(provider.capabilities.costReporting).toBe(true);
    expect(provider.capabilities.contextWindowTokens).toBeGreaterThan(0);
  });

  it('streams start, deltas, usage and done in order', async () => {
    const events = await collect(new MockAiProvider({ chunkDelayMs: 0 }));
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.some((event) => event.type === 'usage')).toBe(true);
    const deltas = events.filter((event) => event.type === 'delta');
    expect(deltas.length).toBeGreaterThan(5);
  });

  it('numbers deltas monotonically', async () => {
    const events = await collect(new MockAiProvider({ chunkDelayMs: 0 }));
    const sequences = events
      .filter((event): event is Extract<AiStreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('assembles the same text as the non-streaming call', async () => {
    const provider = new MockAiProvider({ chunkDelayMs: 0 });
    const events = await collect(provider);
    const streamed = events
      .filter((event): event is Extract<AiStreamEvent, { type: 'delta' }> => event.type === 'delta')
      .map((event) => event.text)
      .join('');
    const generated = await provider.generate(request);
    expect(streamed).toBe(generated.text);
  });

  it('reports usage with tokens, provider, model and duration', async () => {
    const result = await new MockAiProvider().generate(request);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.provider).toBe('mock');
    expect(result.usage.model).toBe('exocortex-mock-1');
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(1);
    expect(result.usage.cachedInputTokens).toBe(0);
  });

  it('stops streaming when the caller aborts', async () => {
    const controller = new AbortController();
    const provider = new MockAiProvider({ chunkDelayMs: 5 });
    const events: AiStreamEvent[] = [];
    for await (const event of provider.stream({ ...request, signal: controller.signal })) {
      events.push(event);
      if (events.length === 3) controller.abort();
    }
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'ai_cancelled',
      message: 'AI run was cancelled',
    });
  });

  it('echoes the user question in the answer', async () => {
    const result = await new MockAiProvider().generate(request);
    expect(result.text).toContain('Was ist Exocortex?');
  });
});

describe('createAiProvider', () => {
  it('returns the mock provider by default', () => {
    const provider = createAiProvider({
      providerId: 'mock',
      logger: { child: () => ({}) } as never,
      appUrl: 'http://localhost:3210',
    });
    expect(provider.id).toBe('mock');
  });
});
