import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { workItemGetTool, workItemListTool, workItemUpdateTool } from './work-items.js';

interface RecordedCall {
  method: string;
  path: string;
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  body?: unknown;
}

function createFakeClient(response: unknown): {
  client: ExocortexApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: ExocortexApiClient = {
    async request(input) {
      calls.push({ method: input.method, path: input.path, query: input.query, body: input.body });
      return input.responseSchema.parse(response);
    },
    async upload(input) {
      return input.responseSchema.parse(response);
    },
  };
  return { client, calls };
}

const NOW = '2026-09-26T10:00:00.000Z';

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item1234567',
    workspaceId: 'ws12345678',
    title: 'Quellen sammeln',
    status: 'waiting_for_human',
    statusReason: 'Brauche Zugang zum Archiv',
    priority: 'high',
    requester: { kind: 'human', userId: 'user123456', name: 'Johanna' },
    assignee: { kind: 'assistant', userId: null, name: null },
    dueAt: null,
    parentId: null,
    childCount: 0,
    runCount: 1,
    criteriaMet: 1,
    criteriaTotal: 2,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function detail() {
  return {
    ...summary(),
    goal: 'Drei Quellen zum Thema finden.',
    acceptanceCriteria: [
      { text: 'Mit Link', met: true },
      { text: 'Auf Deutsch', met: false },
    ],
    result: null,
    budgetMicroUsd: 500_000,
    spentMicroUsd: 12_000,
    parent: null,
    contextRefs: [{ documentId: 'page123456', title: 'Notizen' }],
    resultRefs: [],
    children: [],
    runs: [
      {
        id: 'run1234567',
        status: 'completed',
        model: 'mock/model',
        conversationId: 'conv123456',
        createdById: 'user123456',
        createdAt: NOW,
        finishedAt: NOW,
        costMicroUsd: 12_000,
        errorCode: null,
      },
    ],
    events: [
      {
        id: 'event12345',
        kind: 'status_changed',
        actor: { kind: 'assistant', userId: 'user123456', name: 'Johanna' },
        agentLabel: null,
        data: { from: 'working', to: 'waiting_for_human' },
        note: null,
        createdAt: NOW,
      },
    ],
    checkpointCount: 1,
    latestCheckpointAt: NOW,
  };
}

describe('work item tools', () => {
  it('lists with the filters as query parameters and names what the item waits on', async () => {
    const { client, calls } = createFakeClient({ workItems: [summary()], truncated: false });
    const result = await workItemListTool.run(client, {
      workspaceId: 'ws12345678',
      assignee: 'assistant',
      open: 'all',
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/workspaces/ws12345678/work-items',
      query: { assignee: 'assistant', open: 'all' },
    });
    expect(result.text).toContain('waiting_for_human');
    expect(result.text).toContain('„Brauche Zugang zum Archiv“');
    expect(result.text).toContain('an eingebaute KI');
    expect(result.text).toContain('Kriterien 1/2');
  });

  it('sends the changes flat, without the id, as the PATCH body', async () => {
    const { client, calls } = createFakeClient({ workItem: detail() });
    await workItemUpdateTool.run(client, {
      workItemId: 'item1234567',
      status: 'review',
      result: 'Drei Quellen gefunden.',
    });
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: '/api/work-items/item1234567',
      query: undefined,
      body: { status: 'review', result: 'Drei Quellen gefunden.' },
    });
  });

  it('reads the criteria, the context, the runs and the budget back', async () => {
    const { client } = createFakeClient({ workItem: detail() });
    const result = await workItemGetTool.run(client, { workItemId: 'item1234567' });
    expect(result.text).toContain('- [x] Mit Link');
    expect(result.text).toContain('Notizen (id: page123456)');
    expect(result.text).toContain('run1234567 · completed');
    expect(result.text).toContain('12000 von 500000');
  });
});
