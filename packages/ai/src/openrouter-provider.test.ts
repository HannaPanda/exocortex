import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { OpenRouterProvider } from './openrouter-provider';
import { type AiStreamEvent } from './provider';

const logger = createLogger({ name: 'test', level: 'silent' });

function provider(): OpenRouterProvider {
  return new OpenRouterProvider({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.test/api/v1',
    defaultModel: 'test/model',
    logger,
    appUrl: 'https://exocortex.test',
  });
}

/**
 * Builds a streaming response out of the chunks a caller wants delivered.
 *
 * The fragments are deliberately not aligned with line boundaries: OpenRouter
 * splits its `data:` lines wherever the socket happens to flush, and the reader
 * has to reassemble them. A test that hands over one whole line per read would
 * never exercise that.
 */
function streamResponse(chunks: readonly unknown[], splitEvery = 17): Response {
  const payload = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n')}\ndata: [DONE]\n`;
  const bytes = new TextEncoder().encode(payload);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += splitEvery) {
        controller.enqueue(bytes.slice(offset, offset + splitEvery));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collect(events: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const collected: AiStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

const request = {
  messages: [{ role: 'user', content: 'Wie spät ist es?' }],
  correlationId: 'test-correlation',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterProvider.stream', () => {
  it('reassembles a tool call that arrives in fragments', async () => {
    // The first chunk for an index carries id and name, later chunks only
    // append to the arguments. Anything that overwrites instead of appending
    // produces valid-looking JSON that is missing its middle.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: 'exo_search', arguments: '{"q"' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Term' } }] } }],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'ine"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );

    const events = await collect(provider().stream(request));

    expect(events).toContainEqual({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'exo_search', argumentsJson: '{"q":"Termine"}' }],
    });
    expect(events.at(-1)).toEqual({ type: 'done', text: '', finishReason: 'tool_calls' });
  });

  it('keeps two parallel tool calls apart and orders them by index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"b"' } },
                    { index: 0, id: 'call_a', function: { name: 'first', arguments: '{"a"' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: ':1}' } },
                    { index: 1, function: { arguments: ':2}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ),
    );

    const events = await collect(provider().stream(request));
    const toolCalls = events.find((event) => event.type === 'tool_calls');

    expect(toolCalls).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_a', name: 'first', argumentsJson: '{"a":1}' },
        { id: 'call_b', name: 'second', argumentsJson: '{"b":2}' },
      ],
    });
  });

  it('streams text deltas with a rising sequence and never leaks reasoning text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamResponse([
          { choices: [{ delta: { reasoning: 'Ich überlege kurz.' } }] },
          { choices: [{ delta: { content: 'Es ist ' } }] },
          { choices: [{ delta: { content: 'sechs.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
      ),
    );

    const events = await collect(provider().stream(request));

    expect(events).toContainEqual({ type: 'reasoning', charCount: 18 });
    expect(JSON.stringify(events)).not.toContain('überlege');
    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', text: 'Es ist ', sequence: 1 },
      { type: 'delta', text: 'sechs.', sequence: 2 },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Es ist sechs.', finishReason: 'stop' });
  });

  it('skips a malformed chunk instead of failing the whole stream', async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"vor"}}]}',
      'data: {nope',
      'data: {"choices":[{"delta":{"content":"nach"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(payload, { status: 200 })),
    );

    const events = await collect(provider().stream(request));

    expect(events.at(-1)).toEqual({ type: 'done', text: 'vornach', finishReason: 'stop' });
  });

  it('reports an unavailable provider as an error event rather than throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 502 })),
    );

    const events = await collect(provider().stream(request));

    expect(events).toContainEqual({
      type: 'error',
      code: 'ai_provider_unavailable',
      message: 'OpenRouter responded with 502',
    });
  });
});
