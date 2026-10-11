import { describe, expect, it } from 'vitest';

import { emptyWorkflowGraph, validateWorkflowGraph } from '@exocortex/contracts';

import { type ExocortexApiClient } from '../client.js';

import { EXAMPLE_WORKFLOW_GRAPH, WORKFLOW_TOOLS } from './workflows.js';

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
  draftAuthor: { kind: 'agent', account: null, agentLabel: 'Hermes', aiRunId: null, at: NOW },
  createdBy: null,
  updatedBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe('workflow tools', () => {
  it('offers drafting on both surfaces, deleting and runs on MCP only, and no publish', () => {
    const both = WORKFLOW_TOOLS.filter((entry) => entry.surfaces.includes('ai')).map(
      (entry) => entry.name,
    );
    expect(both.filter((name) => tool(name).mutating).toSorted()).toEqual([
      'exo_workflow_create',
      'exo_workflow_duplicate',
      'exo_workflow_update',
    ]);
    for (const name of [
      'exo_workflow_delete',
      'exo_workflow_run_start',
      'exo_workflow_run_cancel',
    ]) {
      expect(tool(name).surfaces).toEqual(['mcp']);
    }
    const names = WORKFLOW_TOOLS.map((entry) => entry.name);
    expect(names).not.toContain('exo_workflow_publish');
    expect(names).not.toContain('exo_workflow_activate');
    expect(WORKFLOW_TOOLS.every((entry) => entry.domain === 'workflows')).toBe(true);
  });

  it('documents an example graph that publishes as it is', () => {
    expect(validateWorkflowGraph(EXAMPLE_WORKFLOW_GRAPH).problems).toEqual([]);
    expect(tool('exo_workflow_create').description).toContain('"trigger.schedule"');
    expect(tool('exo_workflow_validate').description).toContain('Reparieren');
  });

  it('copies a draft and says who wrote it', async () => {
    const { client, calls } = fakeClient({
      workflow: { ...summary, name: 'Sonntagsrunde (Kopie)' },
      draft: emptyWorkflowGraph(),
      problems: [],
      envelope: {
        workflowsEnabled: false,
        writeMode: 'direct',
        limits: {
          maxNodeExecutions: 50,
          maxParallelBranches: 4,
          maxLifetimeSeconds: 3600,
          budgetMicroUsd: 1000,
        },
      },
    });
    const result = await tool('exo_workflow_duplicate').run(client, {
      workflowId: 'workflow1234',
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/workflows/workflow1234/duplicate', body: {} },
    ]);
    expect(result.text).toContain('Sonntagsrunde (Kopie)');
    expect(result.text).toContain('Agent Hermes');
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
    const { client } = fakeClient({
      workflow: summary,
      draft: emptyWorkflowGraph(),
      problems: [],
      envelope: {
        workflowsEnabled: false,
        writeMode: 'propose',
        limits: {
          maxNodeExecutions: 200,
          maxParallelBranches: 4,
          maxLifetimeSeconds: 86_400,
          budgetMicroUsd: 2_000_000,
        },
      },
    });
    const result = await tool('exo_workflow_get').run(client, { workflowId: summary.id });
    expect(result.text).toContain('- start [trigger.manual]');
    expect(result.text).toContain('Workflows ausgeschaltet · Schreibmodus höchstens propose');
    expect(result.text).toContain('lässt sich veröffentlichen');
  });
});
