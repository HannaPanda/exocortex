import { HocuspocusProvider } from '@hocuspocus/provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { retireProvider } from './retire-provider';

/**
 * A WebSocket that does nothing on its own: the test decides when it opens,
 * receives and closes. Every construction is recorded, because "no socket is
 * ever constructed again" is the property under test.
 */
class FakeSocket {
  static constructed: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.constructed.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

function connectedProvider(): { provider: HocuspocusProvider; socket: FakeSocket } {
  // The provider hands its whole configuration to the websocket it creates, so
  // the polyfill reaches the socket although the provider's own type does not
  // name it. A variable rather than a literal keeps the excess-property check
  // from refusing the key the runtime reads.
  const configuration = {
    url: 'ws://collab.test/collab',
    name: 'document',
    document: new Y.Doc(),
    token: 'ticket',
    WebSocketPolyfill: FakeSocket,
  };
  const provider = new HocuspocusProvider(configuration);
  const socket = FakeSocket.constructed.at(-1);
  if (socket === undefined) throw new Error('the provider constructed no socket');
  socket.readyState = 1;
  socket.fire('open');
  // The first message is what resolves the connection attempt.
  socket.fire('message', { data: new Uint8Array([0, 0]).buffer });
  return { provider, socket };
}

describe('retireProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.constructed = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('documents the library defect: destroy() alone reconnects after a close', async () => {
    const { provider, socket } = connectedProvider();
    socket.readyState = 3;
    socket.fire('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(200);
    provider.destroy();
    const atDestroy = FakeSocket.constructed.length;

    await vi.advanceTimersByTimeAsync(60_000);

    // If this starts failing, @hocuspocus/provider fixed `connect()` after
    // `destroy()` and retireProvider can go.
    expect(FakeSocket.constructed.length).toBeGreaterThan(atDestroy);
  });

  it('constructs no socket after a destroy that lands inside the reconnect delay', async () => {
    const { provider, socket } = connectedProvider();
    socket.readyState = 3;
    socket.fire('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(200);
    retireProvider(provider);
    const atDestroy = FakeSocket.constructed.length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeSocket.constructed.length).toBe(atDestroy);
  });

  it('constructs no socket after a destroy during a refused reconnect loop', async () => {
    const { provider, socket } = connectedProvider();
    socket.readyState = 3;
    socket.fire('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(1_500);
    // The scheduled reconnect has started; refuse its attempt the way a 502 does.
    const retry = FakeSocket.constructed.at(-1);
    retry?.fire('error');
    retry?.fire('close', { code: 1006, reason: '' });
    retireProvider(provider);
    const atDestroy = FakeSocket.constructed.length;

    await vi.advanceTimersByTimeAsync(120_000);

    expect(FakeSocket.constructed.length).toBe(atDestroy);
  });
});
