import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ExocortexApiClient } from './client.js';
import { WriteConfirmationGate } from './confirm.js';
import {
  createMcpRequestHandler,
  JSON_RPC_ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
} from './protocol.js';
import { type AnyToolDefinition, defineTool } from './tool.js';

const CLIENT: ExocortexApiClient = {
  async request(input) {
    return input.responseSchema.parse({ ok: true });
  },
  async upload(input) {
    return input.responseSchema.parse({ ok: true });
  },
};

const readTool: AnyToolDefinition = defineTool({
  name: 'exo_read_thing',
  description: 'Liest ein Ding und gibt seinen Namen zurück.',
  inputSchema: z.object({ id: z.string() }),
  surfaces: ['mcp'],
  mutating: false,
  async execute(_client, input) {
    return { text: `gelesen: ${input.id}` };
  },
});

const writeTool: AnyToolDefinition = defineTool({
  name: 'exo_write_thing',
  description: 'Schreibt ein Ding und verändert damit Daten.',
  inputSchema: z.object({ id: z.string(), body: z.string() }),
  surfaces: ['mcp'],
  mutating: true,
  target: (input) => `thing:${input.id}`,
  async execute(_client, input) {
    return { text: `geschrieben: ${input.id}` };
  },
});

function handlerWith(options?: { gate?: WriteConfirmationGate; principal?: string }) {
  return createMcpRequestHandler({
    client: CLIENT,
    tools: [readTool, writeTool],
    ...(options?.gate === undefined ? {} : { gate: options.gate }),
    ...(options?.principal === undefined ? {} : { principal: options.principal }),
  });
}

describe('createMcpRequestHandler', () => {
  it('echoes a protocol version it knows and offers the newest otherwise', async () => {
    const handler = handlerWith();

    const known = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    const unknown = await handler({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });

    expect((known as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      '2025-03-26',
    );
    expect((unknown as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    );
  });

  it('answers notifications with nothing at all', async () => {
    const handler = handlerWith();
    expect(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists only the tools it was given', async () => {
    const handler = handlerWith();
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (response as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(['exo_read_thing', 'exo_write_thing']);
  });

  it('annotates every tool as reading or writing', async () => {
    // A client that gates write access behind its own opt-in has no other way
    // to tell the two apart, and answering without the hints puts the whole
    // catalogue on the wrong side of that gate.
    const handler = handlerWith();
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (
      response as {
        result: { tools: { name: string; annotations: Record<string, boolean> }[] };
      }
    ).result.tools;

    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    expect(byName.get('exo_read_thing')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get('exo_write_thing')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('never calls a read-only tool destructive', async () => {
    const confused = defineTool({
      name: 'exo_confused_thing',
      description: 'Behauptet zu zerstören, verändert aber nichts.',
      inputSchema: z.object({ id: z.string() }),
      surfaces: ['mcp'],
      mutating: false,
      destructive: true,
      async execute() {
        return { text: 'nichts passiert' };
      },
    });
    expect(confused.destructive).toBe(false);
  });

  it('refuses a tool that is not on this connection, even if it exists elsewhere', async () => {
    // The whole point of serving a subset: naming a tool must not be enough to
    // reach it.
    const handler = createMcpRequestHandler({ client: CLIENT, tools: [readTool] });
    const response = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    });
    expect((response as { error: { code: number } }).error.code).toBe(
      JSON_RPC_ERROR_CODES.invalidParams,
    );
  });

  it('reports invalid tool input as a readable result, not a protocol error', async () => {
    const handler = handlerWith();
    const response = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_read_thing', arguments: {} },
    });
    const result = (response as { result: { isError: boolean; content: { text: string }[] } })
      .result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Ungültige Eingabe');
  });

  it('runs a mutating tool only on the repeated, identical call', async () => {
    const gate = new WriteConfirmationGate();
    const handler = handlerWith({ gate });
    const call = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    };

    const first = await handler(call);
    const second = await handler(call);

    expect((first as { result: { content: { text: string }[] } }).result.content[0]?.text).toContain(
      'noch NICHT ausgeführt',
    );
    expect(
      (second as { result: { content: { text: string }[] } }).result.content[0]?.text,
    ).toBe('geschrieben: a');
  });

  it('does not let one caller confirm another caller’s pending write', async () => {
    // One gate serves the whole deployment over HTTP. Without the principal in
    // the key, Bob's first call would fire the write Alice announced.
    const gate = new WriteConfirmationGate();
    const alice = handlerWith({ gate, principal: 'user-alice' });
    const bob = handlerWith({ gate, principal: 'user-bob' });
    const call = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    };

    await alice(call);
    const bobsFirst = await bob(call);

    expect(
      (bobsFirst as { result: { content: { text: string }[] } }).result.content[0]?.text,
    ).toContain('noch NICHT ausgeführt');
  });

  it('writes straight through when no gate is configured', async () => {
    const handler = handlerWith();
    const response = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    });
    expect(
      (response as { result: { content: { text: string }[] } }).result.content[0]?.text,
    ).toBe('geschrieben: a');
  });

  it('answers the capability probes a client sends on connect', async () => {
    const handler = handlerWith();
    for (const [method, key] of [
      ['resources/list', 'resources'],
      ['resources/templates/list', 'resourceTemplates'],
      ['prompts/list', 'prompts'],
    ] as const) {
      const response = await handler({ jsonrpc: '2.0', id: 1, method });
      expect((response as { result: Record<string, unknown[]> }).result[key]).toEqual([]);
    }
  });

  it('reports an unknown method as method-not-found', async () => {
    const handler = handlerWith();
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'completion/complete' });
    expect((response as { error: { code: number } }).error.code).toBe(
      JSON_RPC_ERROR_CODES.methodNotFound,
    );
  });
});
