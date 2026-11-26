import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toolsFor } from './catalog.js';
import { type ExocortexApiClient } from './client.js';
import { WriteConfirmationGate } from './confirm.js';
import { COMPACT_ENDPOINT_DOMAINS, COMPACT_ENDPOINT_EXECUTABLE } from './domains.js';
import { createMcpRequestHandler, type JsonRpcResponse } from './protocol.js';
import { type AnyToolDefinition, defineTool } from './tool.js';

/**
 * `exo_tool_search` and `exo_tool_execute` (issue #256): finding and calling
 * a tool the connection was not listed, through the connection's own
 * dispatcher and nowhere else.
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

describe('tool discovery', () => {
  it('lists the two meta-tools beside the listed ones, and nothing hidden', async () => {
    const response = await handler()({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (
      response as { result: { tools: { name: string; annotations: Record<string, boolean> }[] } }
    ).result.tools;
    expect(tools.map((entry) => entry.name)).toEqual([
      'exo_page_read',
      'exo_tool_search',
      'exo_tool_execute',
    ]);
    // A client that asks its person before a write must ask before this one.
    expect(tools.find((entry) => entry.name === 'exo_tool_execute')?.annotations).toEqual({
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

  it('finds hidden tools by inflected words, says which are callable, and never the listed ones', async () => {
    const result = await call(handler(), 'exo_tool_search', { query: 'Entitäten der Seite' });
    const results = (result.structuredContent?.results ?? []) as {
      name: string;
      executable: boolean;
      operation: string;
      inputSchema?: unknown;
      reason?: string;
    }[];
    const names = results.map((entry) => entry.name);
    expect(names).toContain('exo_entity_list');
    expect(names).not.toContain('exo_page_read');
    expect(results.find((entry) => entry.name === 'exo_entity_list')).toMatchObject({
      executable: true,
      operation: 'read',
      inputSchema: expect.objectContaining({ type: 'object' }),
    });
    const refused = results.find((entry) => entry.name === 'exo_entity_delete');
    expect(refused).toMatchObject({ executable: false, reason: 'irreversible' });
    expect(refused?.inputSchema).toBeUndefined();
  });

  it('caps the number of results', async () => {
    const result = await call(handler(), 'exo_tool_search', { query: 'liest listet', limit: 1 });
    expect(result.structuredContent?.results).toHaveLength(1);
  });

  it('runs an allowed hidden tool through the same dispatcher', async () => {
    calls.length = 0;
    const result = await call(handler(), 'exo_tool_execute', {
      tool: 'exo_entity_list',
      arguments: { id: 'x' },
    });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('exo_entity_list x');
    expect(calls).toEqual(['exo_entity_list:x']);
  });

  it("validates against the target's own schema and runs nothing on a bad input", async () => {
    calls.length = 0;
    const result = await call(handler(), 'exo_tool_execute', {
      tool: 'exo_page_set_layout',
      arguments: { wrong: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: 'invalid_input' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['exo_nothing_like_it', 'tool_unknown'],
    ['exo_page_read', 'tool_directly_exposed'],
    ['exo_tool_execute', 'tool_recursive'],
    ['exo_tool_search', 'tool_recursive'],
    ['exo_entity_delete', 'tool_irreversible'],
    ['exo_share_list', 'tool_not_allowed'],
  ])('refuses %s with %s and runs nothing', async (name, code) => {
    calls.length = 0;
    const result = await call(handler(), 'exo_tool_execute', {
      tool: name,
      arguments: { id: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: code, tool: name });
    expect(calls).toEqual([]);
  });

  it('keeps the confirmation gate on the target, asked once, not on the envelope', async () => {
    calls.length = 0;
    const handle = handler({ gate: new WriteConfirmationGate(), confirm: 'all' });
    const args = { tool: 'exo_page_set_layout', arguments: { id: 'p' } };

    const first = await call(handle, 'exo_tool_execute', args);
    expect(first.content[0]?.text).toContain('noch NICHT ausgeführt');
    expect(calls).toEqual([]);

    const second = await call(handle, 'exo_tool_execute', args);
    expect(second.content[0]?.text).toBe('exo_page_set_layout p');
    expect(calls).toEqual(['exo_page_set_layout:p']);
  });
});

describe('the compact endpoint allowlist', () => {
  // The spike's premise: one read and one undoable write, both really absent
  // from the compact list, and none of them able to take anything away.
  const compact = new Set(
    toolsFor('mcp', { domains: COMPACT_ENDPOINT_DOMAINS }).map((t) => t.name),
  );
  const full = new Map(toolsFor('mcp').map((entry) => [entry.name, entry]));

  it('names tools of the mcp surface that the compact list leaves out', () => {
    for (const name of COMPACT_ENDPOINT_EXECUTABLE) {
      expect(full.has(name), name).toBe(true);
      expect(compact.has(name), name).toBe(false);
    }
  });

  it('holds exactly one read and one write, neither destructive', () => {
    const entries = COMPACT_ENDPOINT_EXECUTABLE.map((name) => full.get(name));
    expect(entries.filter((entry) => entry?.mutating === false)).toHaveLength(1);
    expect(entries.filter((entry) => entry?.mutating === true)).toHaveLength(1);
    expect(
      entries.some((entry) => entry?.destructive === true || entry?.irreversible === true),
    ).toBe(false);
  });
});
