import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createStdioServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type StdioIo,
} from './stdio.js';

/** A fake `StdioIo`: an EventEmitter standing in for stdin, plus a recording `write`. */
function createFakeIo(): {
  io: StdioIo;
  input: EventEmitter;
  writes: JsonRpcResponse[];
  state: { ended: boolean };
} {
  const input = new EventEmitter();
  const writes: JsonRpcResponse[] = [];
  const state = { ended: false };
  const io: StdioIo = {
    input: {
      setEncoding: () => undefined,
      on: (event, listener) => {
        input.on(event, listener as (...args: unknown[]) => void);
      },
    },
    write: (message) => writes.push(message),
    onEnd: () => {
      state.ended = true;
    },
  };
  return { io, input, writes, state };
}

function feed(input: EventEmitter, line: string): void {
  input.emit('data', `${line}\n`);
}

describe('createStdioServer', () => {
  it('responds to a parse error with id: null', () => {
    const { io, input, writes } = createFakeIo();
    const handler = vi.fn(async (): Promise<JsonRpcResponse | null> => null);
    createStdioServer(handler, io).start();

    feed(input, 'not valid json{{{');

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('echoes the id of a malformed request that still carries one', () => {
    const { io, input, writes } = createFakeIo();
    const handler = vi.fn(async (): Promise<JsonRpcResponse | null> => null);
    createStdioServer(handler, io).start();

    // Valid JSON, but no `method`: invalid as a JSON-RPC request.
    feed(input, JSON.stringify({ jsonrpc: '2.0', id: 42 }));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ jsonrpc: '2.0', id: 42, error: { code: -32600 } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports an unknown method as -32601 with the request id', async () => {
    const { io, input, writes } = createFakeIo();
    const handler = vi.fn(async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => ({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    }));
    createStdioServer(handler, io).start();

    feed(input, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'no/such/method' }));
    // The handler resolves asynchronously; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } });
  });

  it('produces no output for a notification (no id)', async () => {
    const { io, input, writes } = createFakeIo();
    const handler = vi.fn(async (): Promise<JsonRpcResponse | null> => null);
    createStdioServer(handler, io).start();

    feed(input, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(0);
  });

  it('calls onEnd when the input stream ends', () => {
    const { io, input, state } = createFakeIo();
    const handler = vi.fn(async (): Promise<JsonRpcResponse | null> => null);
    createStdioServer(handler, io).start();

    input.emit('end');

    expect(state.ended).toBe(true);
  });
});
