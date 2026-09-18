import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ExocortexApiClient } from './client.js';
import { WriteConfirmationGate } from './confirm.js';
import {
  createMcpRequestHandler,
  JSON_RPC_ERROR_CODES,
  LATEST_PROTOCOL_VERSION,
  toMcpToolList,
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

const deleteTool: AnyToolDefinition = defineTool({
  name: 'exo_delete_thing',
  description: 'Löscht ein Ding endgültig, ohne dass ein Snapshot es zurückholt.',
  inputSchema: z.object({ id: z.string() }),
  surfaces: ['mcp'],
  mutating: true,
  destructive: true,
  irreversible: true,
  target: (input) => `thing:${input.id}`,
  async execute(_client, input) {
    return { text: `gelöscht: ${input.id}` };
  },
});

function handlerWith(options?: {
  gate?: WriteConfirmationGate;
  principal?: string;
  confirm?: 'irreversible' | 'all';
  context?: boolean;
}) {
  return createMcpRequestHandler({
    client: CLIENT,
    tools: [readTool, writeTool, deleteTool],
    ...(options?.gate === undefined ? {} : { gate: options.gate }),
    ...(options?.principal === undefined ? {} : { principal: options.principal }),
    ...(options?.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options?.context === undefined ? {} : { context: options.context }),
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
    expect(names).toEqual(['exo_read_thing', 'exo_write_thing', 'exo_delete_thing']);
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

  it('marks a tool that reaches the open web as open-world', () => {
    const webTool = defineTool({
      name: 'exo_web_thing',
      description: 'Holt etwas aus dem Web.',
      inputSchema: z.object({ url: z.string() }),
      surfaces: ['mcp'],
      mutating: false,
      untrustedOutput: 'web',
      async execute() {
        return { text: 'ok' };
      },
    });
    expect(toMcpToolList([webTool, readTool])).toEqual([
      expect.objectContaining({
        name: 'exo_web_thing',
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      }),
      expect.objectContaining({
        name: 'exo_read_thing',
        // An uploaded document is foreign text but it is *ours*: nothing
        // reached outside this deployment to get it.
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      }),
    ]);
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

  it('runs an irreversible tool only on the repeated, identical call', async () => {
    const gate = new WriteConfirmationGate();
    const handler = handlerWith({ gate });
    const call = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_delete_thing', arguments: { id: 'a' } },
    };

    const first = await handler(call);
    const second = await handler(call);

    expect(
      (first as { result: { content: { text: string }[] } }).result.content[0]?.text,
    ).toContain('noch NICHT ausgeführt');
    expect((second as { result: { content: { text: string }[] } }).result.content[0]?.text).toBe(
      'gelöscht: a',
    );
  });

  it('lets an ordinary write through on the first call, gate or no gate', async () => {
    // The gate is spent on what no snapshot undoes. An append that a snapshot
    // covers, and that the client already asked its human about, does not pay
    // the two-call price -- that price was what stranded models mid-loop.
    const handler = handlerWith({ gate: new WriteConfirmationGate() });
    const response = await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    });

    expect((response as { result: { content: { text: string }[] } }).result.content[0]?.text).toBe(
      'geschrieben: a',
    );
  });

  it('puts every write behind the gate when the deployment asks for it', async () => {
    const gate = new WriteConfirmationGate();
    const handler = handlerWith({ gate, confirm: 'all' });
    const call = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'exo_write_thing', arguments: { id: 'a', body: 'b' } },
    };

    const first = await handler(call);
    const second = await handler(call);

    expect(
      (first as { result: { content: { text: string }[] } }).result.content[0]?.text,
    ).toContain('noch NICHT ausgeführt');
    expect((second as { result: { content: { text: string }[] } }).result.content[0]?.text).toBe(
      'geschrieben: a',
    );
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
      params: { name: 'exo_delete_thing', arguments: { id: 'a' } },
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
    expect((response as { result: { content: { text: string }[] } }).result.content[0]?.text).toBe(
      'geschrieben: a',
    );
  });

  it('answers the capability probes a surface without them still gets', async () => {
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

  it('announces resources and prompts only where it serves them', async () => {
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize' } as const;
    const capabilitiesOf = async (context: boolean): Promise<Record<string, unknown>> => {
      const response = await handlerWith({ context })(initialize);
      return (response as { result: { capabilities: Record<string, unknown> } }).result
        .capabilities;
    };

    // An unannounced capability is an unreachable one: no client asks for
    // what the handshake did not offer.
    expect(await capabilitiesOf(false)).toEqual({ tools: { listChanged: false } });
    expect(await capabilitiesOf(true)).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
  });

  it('serves the URI templates once resources are switched on', async () => {
    const response = await handlerWith({ context: true })({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/templates/list',
    });
    const { resourceTemplates } = (
      response as { result: { resourceTemplates: { uriTemplate: string }[] } }
    ).result;
    expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      'exocortex://page/{documentId}',
      'exocortex://workspace/{workspaceId}/tree',
    ]);
  });

  it('refuses a resource URI it does not own, without reaching the API', async () => {
    const response = await handlerWith({ context: true })({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'file:///etc/passwd' },
    });
    expect((response as { error: { code: number } }).error.code).toBe(
      JSON_RPC_ERROR_CODES.resourceNotFound,
    );
  });

  it('reports an unknown method as method-not-found', async () => {
    const handler = handlerWith();
    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'completion/complete' });
    expect((response as { error: { code: number } }).error.code).toBe(
      JSON_RPC_ERROR_CODES.methodNotFound,
    );
  });
});

describe('agent session (ADR-022)', () => {
  /** A client that records the announcement and the stamp it was given. */
  function recordingClient() {
    const calls: { path: string; body: unknown }[] = [];
    let stamped: { externalId: string; label?: string } | null = null;
    const client: ExocortexApiClient = {
      async request(input) {
        calls.push({ path: input.path, body: input.body });
        return input.responseSchema.parse({ id: 'sess-row', externalId: 'sess-1' });
      },
      async upload(input) {
        return input.responseSchema.parse({ ok: true });
      },
      setAgentSession(session) {
        stamped = session;
      },
    };
    return { client, calls, stamp: () => stamped };
  }

  it('announces the session at initialize and stamps the client with the label', async () => {
    const recorder = recordingClient();
    const handler = createMcpRequestHandler({
      client: recorder.client,
      tools: [readTool],
      agentSession: { externalId: 'sess-1', transport: 'stdio' },
    });

    await handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'claude-code', version: '1.2' } },
    });

    expect(recorder.calls[0]?.path).toBe('/api/agent-sessions');
    expect(recorder.calls[0]?.body).toMatchObject({
      externalId: 'sess-1',
      clientLabel: 'claude-code 1.2',
      transport: 'stdio',
    });
    expect(recorder.stamp()).toEqual({ externalId: 'sess-1', label: 'claude-code 1.2' });
  });

  it('stamps the client even without an initialize, which is what HTTP needs', async () => {
    const recorder = recordingClient();
    createMcpRequestHandler({
      client: recorder.client,
      tools: [readTool],
      agentSession: { externalId: 'sess-2', transport: 'http' },
    });

    expect(recorder.stamp()).toEqual({ externalId: 'sess-2' });
    expect(recorder.calls).toHaveLength(0);
  });

  it('completes the handshake even when the announcement fails', async () => {
    const client: ExocortexApiClient = {
      async request() {
        throw new Error('API unreachable');
      },
      async upload(input) {
        return input.responseSchema.parse({ ok: true });
      },
    };
    const warnings: string[] = [];
    const handler = createMcpRequestHandler({
      client,
      tools: [readTool],
      agentSession: { externalId: 'sess-3', transport: 'stdio' },
      logger: { warn: (message) => warnings.push(message) },
    });

    const response = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect((response as { result: { serverInfo: unknown } }).result.serverInfo).toBeDefined();
    expect(warnings).toContain('Agent session could not be announced');
  });
});
