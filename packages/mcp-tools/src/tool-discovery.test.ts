import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type ExocortexApiClient } from './client.js';
import { WriteConfirmationGate } from './confirm.js';
import { createMcpRequestHandler, type JsonRpcResponse } from './protocol.js';
import { type AnyToolDefinition, defineTool } from './tool.js';

/**
 * `exo_tool_search`, `exo_tool_read` and `exo_tool_write` (issues #256,
 * #265): finding and calling a tool the connection was not listed, through
 * the connection's own dispatcher and nowhere else. `exo_tool_execute` is the
 * spike's name, still callable and no longer listed.
 */

const calls: string[] = [];

const CLIENT: ExocortexApiClient = {
  async request(input) {
    return input.responseSchema.parse({ ok: true });
  },
  async upload(input) {
    return input.responseSchema.parse({ ok: true });
  },
};

function tool(
  name: string,
  description: string,
  flags: { mutating: boolean; destructive?: boolean; irreversible?: boolean },
): AnyToolDefinition {
  return defineTool({
    name,
    description,
    inputSchema: z.object({ id: z.string() }),
    surfaces: ['mcp'],
    domain: 'core',
    ...flags,
    ...(flags.mutating ? { target: (input: { id: string }) => `thing:${input.id}` } : {}),
    async execute(_client, input) {
      calls.push(`${name}:${input.id}`);
      return { text: `${name} ${input.id}` };
    },
  });
}

const listedTool = tool('exo_page_read', 'Liest eine Seite.', { mutating: false });
const hiddenRead = tool('exo_entity_list', 'Listet die bekannten Entitäten.', { mutating: false });
const hiddenWrite = tool('exo_page_set_layout', 'Setzt die Breite des Seitenkörpers.', {
  mutating: true,
});
const hiddenOther = tool('exo_share_list', 'Listet die Freigaben einer Seite.', {
  mutating: false,
});
const hiddenDelete = tool('exo_entity_delete', 'Löscht eine Entität endgültig.', {
  mutating: true,
  destructive: true,
  irreversible: true,
});

function handler(options?: { gate?: WriteConfirmationGate; confirm?: 'all' | 'irreversible' }) {
  return createMcpRequestHandler({
    client: CLIENT,
    tools: [listedTool],
    discovery: {
      catalogue: [listedTool, hiddenRead, hiddenWrite, hiddenOther, hiddenDelete],
      // The delete is named on purpose: the list must not be able to reach it.
      executable: ['exo_entity_list', 'exo_page_set_layout', 'exo_entity_delete'],
    },
    ...(options?.gate === undefined ? {} : { gate: options.gate }),
    ...(options?.confirm === undefined ? {} : { confirm: options.confirm }),
  });
}

interface CallResult {
  isError: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}

function resultOf(response: JsonRpcResponse | null): CallResult {
  return (response as { result: CallResult }).result;
}

async function call(
  handle: ReturnType<typeof handler>,
  name: string,
  args: unknown,
): Promise<CallResult> {
  return resultOf(
    await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  );
}

interface ListedTool {
  name: string;
  annotations: Record<string, boolean>;
}

async function listed(handle: ReturnType<typeof handler>): Promise<ListedTool[]> {
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return (response as { result: { tools: ListedTool[] } }).result.tools;
}

describe('tool discovery', () => {
  it('lists search and the two dispatchers beside the listed tools, nothing hidden, no alias', async () => {
    const tools = await listed(handler());
    expect(tools.map((entry) => entry.name)).toEqual([
      'exo_page_read',
      'exo_tool_search',
      'exo_tool_read',
      'exo_tool_write',
    ]);
  });

  it('marks the read dispatcher read-only and the write dispatcher as a non-destructive write', async () => {
    const tools = await listed(handler());
    const hints = (name: string) => tools.find((entry) => entry.name === name)?.annotations;
    expect(hints('exo_tool_search')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    // A client that asks its person before a write needs no dialog for this one.
    expect(hints('exo_tool_read')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    // ...and must ask before this one.
    expect(hints('exo_tool_write')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it('lists no meta-tools when the connection asks for no discovery', async () => {
    const plain = createMcpRequestHandler({ client: CLIENT, tools: [listedTool] });
    const response = await plain({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (response as { result: { tools: { name: string }[] } }).result.tools.map(
      (entry) => entry.name,
    );
    expect(names).toEqual(['exo_page_read']);
  });

  it('finds hidden tools by inflected words, names the dispatcher, and never the listed ones', async () => {
    const result = await call(handler(), 'exo_tool_search', { query: 'Entitäten der Seite' });
    const results = (result.structuredContent?.results ?? []) as {
      name: string;
      executable: boolean;
      operation: string;
      dispatcher?: string;
      inputSchema?: unknown;
      reason?: string;
    }[];
    const names = results.map((entry) => entry.name);
    expect(names).toContain('exo_entity_list');
    expect(names).not.toContain('exo_page_read');
    expect(results.find((entry) => entry.name === 'exo_entity_list')).toMatchObject({
      executable: true,
      operation: 'read',
      dispatcher: 'exo_tool_read',
      inputSchema: expect.objectContaining({ type: 'object' }),
    });
    const refused = results.find((entry) => entry.name === 'exo_entity_delete');
    expect(refused).toMatchObject({ executable: false, reason: 'irreversible' });
    expect(refused?.inputSchema).toBeUndefined();
    expect(refused?.dispatcher).toBeUndefined();
  });

  it('finds a compound the descriptions only spell apart', async () => {
    const result = await call(handler(), 'exo_tool_search', { query: 'Seitenkörperbreite' });
    const results = (result.structuredContent?.results ?? []) as {
      name: string;
      dispatcher?: string;
    }[];
    expect(results[0]).toMatchObject({ name: 'exo_page_set_layout', dispatcher: 'exo_tool_write' });
  });

  it('uses the words handed in per tool', async () => {
    const handle = createMcpRequestHandler({
      client: CLIENT,
      tools: [listedTool],
      discovery: {
        catalogue: [listedTool, hiddenRead, hiddenOther],
        executable: ['exo_entity_list'],
        searchText: new Map([['exo_share_list', 'Wer darf mitlesen']]),
      },
    });
    const result = await call(handle, 'exo_tool_search', { query: 'mitlesen' });
    expect(result.structuredContent?.results).toEqual([
      expect.objectContaining({ name: 'exo_share_list', executable: false }),
    ]);
  });

  it('caps the number of results', async () => {
    const result = await call(handler(), 'exo_tool_search', { query: 'liest listet', limit: 1 });
    expect(result.structuredContent?.results).toHaveLength(1);
  });

  it.each(['exo_tool_read', 'exo_tool_write', 'exo_tool_execute'])(
    'runs an allowed hidden read through %s and the same dispatcher',
    async (dispatcher) => {
      calls.length = 0;
      const result = await call(handler(), dispatcher, {
        tool: 'exo_entity_list',
        arguments: { id: 'x' },
      });
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toBe('exo_entity_list x');
      expect(calls).toEqual(['exo_entity_list:x']);
    },
  );

  it.each(['exo_tool_write', 'exo_tool_execute'])(
    'runs an allowed hidden write through %s',
    async (dispatcher) => {
      calls.length = 0;
      const result = await call(handler(), dispatcher, {
        tool: 'exo_page_set_layout',
        arguments: { id: 'p' },
      });
      expect(result.isError).toBe(false);
      expect(calls).toEqual(['exo_page_set_layout:p']);
    },
  );

  it('refuses a writing tool on the read dispatcher, whatever the call says, and runs nothing', async () => {
    calls.length = 0;
    const result = await call(handler(), 'exo_tool_read', {
      tool: 'exo_page_set_layout',
      arguments: { id: 'p' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: 'tool_not_read_only',
      tool: 'exo_page_set_layout',
    });
    expect(calls).toEqual([]);
  });

  it("validates against the target's own schema and runs nothing on a bad input", async () => {
    calls.length = 0;
    const result = await call(handler(), 'exo_tool_write', {
      tool: 'exo_page_set_layout',
      arguments: { wrong: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  describe.each(['exo_tool_read', 'exo_tool_write', 'exo_tool_execute'])('%s', (dispatcher) => {
    it.each([
      ['exo_nothing_like_it', 'tool_unknown'],
      ['exo_page_read', 'tool_directly_exposed'],
      ['exo_tool_execute', 'tool_recursive'],
      ['exo_tool_read', 'tool_recursive'],
      ['exo_tool_write', 'tool_recursive'],
      ['exo_tool_search', 'tool_recursive'],
      ['exo_entity_delete', 'tool_irreversible'],
      ['exo_share_list', 'tool_not_allowed'],
    ])('refuses %s with %s and runs nothing', async (name, code) => {
      calls.length = 0;
      const result = await call(handler(), dispatcher, { tool: name, arguments: { id: 'x' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: code, tool: name });
      expect(calls).toEqual([]);
    });
  });

  it('keeps the confirmation gate on the target, asked once, not on the envelope', async () => {
    calls.length = 0;
    const handle = handler({ gate: new WriteConfirmationGate(), confirm: 'all' });
    const args = { tool: 'exo_page_set_layout', arguments: { id: 'p' } };

    const first = await call(handle, 'exo_tool_write', args);
    expect(first.content[0]?.text).toContain('noch NICHT ausgeführt');
    expect(calls).toEqual([]);

    const second = await call(handle, 'exo_tool_write', args);
    expect(second.content[0]?.text).toBe('exo_page_set_layout p');
    expect(calls).toEqual(['exo_page_set_layout:p']);
  });
});
