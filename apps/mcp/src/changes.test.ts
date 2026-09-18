import { describe, expect, it, vi } from 'vitest';

import { createChangeFeed } from './changes.js';

const LOGGER = { info: () => undefined, warn: () => undefined };

/** A response whose body is the given SSE text, delivered in one chunk. */
function sseResponse(text: string, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * Serves `text` once and an empty stream on every reconnect after it, so a
 * test can assert what was delivered without the feed's own retries repeating
 * it.
 */
function servesOnce(text: string): () => Promise<Response> {
  let served = false;
  return async () => {
    if (served) return sseResponse('');
    served = true;
    return sseResponse(text);
  };
}

/** Resolves once the feed has stopped opening connections. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve();
  }
}

describe('createChangeFeed', () => {
  it('opens nothing until something is subscribed', async () => {
    const fetchImpl = vi.fn();
    createChangeFeed({
      baseUrl: 'http://api.test',
      token: 'exo_1',
      logger: LOGGER,
      onChange: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });

    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns change frames into URI lists and ignores the handshake and heartbeats', async () => {
    const seen: string[][] = [];
    const fetchImpl = vi.fn(
      servesOnce(
        [
          'data: {"ready":true,"heartbeatSeconds":25}',
          '',
          ': ping',
          '',
          'data: {"uris":["exocortex://page/doc_1"],"changedAt":"2026-09-18T10:00:00.000Z"}',
          '',
          '',
        ].join('\n'),
      ),
    );

    const feed = createChangeFeed({
      baseUrl: 'http://api.test',
      token: 'exo_1',
      logger: LOGGER,
      onChange: (uris) => seen.push([...uris]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    feed.ensureStarted();
    await settle();
    feed.stop();

    expect(seen).toEqual([['exocortex://page/doc_1']]);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer exo_1');
  });

  it('survives a frame it cannot parse rather than closing the stream', async () => {
    const seen: string[][] = [];
    const fetchImpl = vi.fn(
      servesOnce(
        [
          'data: not json at all',
          '',
          'data: {"uris":["exocortex://page/doc_2"],"changedAt":"2026-09-18T10:00:00.000Z"}',
          '',
          '',
        ].join('\n'),
      ),
    );

    const feed = createChangeFeed({
      baseUrl: 'http://api.test',
      token: 'exo_1',
      logger: LOGGER,
      onChange: (uris) => seen.push([...uris]),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    feed.ensureStarted();
    await settle();
    feed.stop();

    expect(seen).toEqual([['exocortex://page/doc_2']]);
  });

  it('reconnects after the stream ends and stops when told to', async () => {
    let opened = 0;
    const fetchImpl = vi.fn(async () => {
      opened += 1;
      return sseResponse('');
    });

    const feed = createChangeFeed({
      baseUrl: 'http://api.test',
      token: 'exo_1',
      logger: LOGGER,
      onChange: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    feed.ensureStarted();
    await settle();
    feed.stop();
    const afterStop = opened;
    await settle();

    // It came back at least once while running, and not once after stopping:
    // a feed that reconnected forever would outlive the client it serves.
    expect(afterStop).toBeGreaterThan(1);
    expect(opened).toBe(afterStop);
  });

  it('does not treat a refusal as a reason to stop trying', async () => {
    let opened = 0;
    const fetchImpl = vi.fn(async () => {
      opened += 1;
      return sseResponse('', 401);
    });

    const feed = createChangeFeed({
      baseUrl: 'http://api.test',
      token: 'exo_1',
      logger: LOGGER,
      onChange: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delay: async () => undefined,
    });
    feed.ensureStarted();
    await settle();
    feed.stop();

    // A token that is momentarily unusable -- a restart mid-rollout -- must
    // not silently end the subscription for the rest of the session.
    expect(opened).toBeGreaterThan(1);
  });
});
