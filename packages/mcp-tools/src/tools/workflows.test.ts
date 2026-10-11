import { describe, expect, it } from 'vitest';

import { emptyWorkflowGraph } from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';

import { WORKFLOW_TOOLS } from './workflows.js';

const NOW = '2026-10-11T10:00:00.000Z';

function fakeClient(response: unknown) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

function tool(name: string) {
  const found = WORKFLOW_TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const summary = {
  id: 'workflow1234',
  workspaceId: 'ws12345678',
  name: 'Sonntagsrunde',
  description: null,
  enabled: false,
  draftRevision: 2,
  draftValid: false,
  hasUnpublishedChanges: true,
  publishedVersion: null,
  triggerTypes: ['trigger.manual'],
  activeRunCount: 0,
  createdBy: null,
  updatedBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('workflow tools', () => {
  it('offers reading and checking on both surfaces, writing on MCP only, and no publish', () => {
    const both = WORKFLOW_TOOLS.filter((entry) => entry.surfaces.includes('ai')).map(
      (entry) => entry.name,
    );
    expect(both.every((name) => !tool(name).mutating)).toBe(true);
    expect(tool('exo_workflow_create').surfaces).toEqual(['mcp']);
    expect(WORKFLOW_TOOLS.map((entry) => entry.name)).not.toContain('exo_workflow_publish');
    expect(WORKFLOW_TOOLS.every((entry) => entry.domain === 'workflows')).toBe(true);
  });

  it('names every problem with its code and element so an agent can repair the graph', async () => {
    const { client, calls } = fakeClient({
      valid: false,
      problems: [
        {
          code: 'edge_invalid_handle',
          message: 'A agent node has no handle "maybe"',
          nodeId: null,
          edgeId: 'e5',
          path: null,
        },
      ],
    });
    const result = await tool('exo_workflow_validate').run(client, {
      workflowId: summary.id,
      graph: { schemaVersion: 1 },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/workflows/${summary.id}/validate`,
      body: { graph: { schemaVersion: 1 } },
    });
    expect(result.text).toContain('[edge_invalid_handle] e5');
  });

  it('shows the draft as nodes and edges', async () => {
    const { client } = fakeClient({ workflow: summary, draft: emptyWorkflowGraph(), problems: [] });
    const result = await tool('exo_workflow_get').run(client, { workflowId: summary.id });
    expect(result.text).toContain('- start [trigger.manual]');
    expect(result.text).toContain('lässt sich veröffentlichen');
  });
});
