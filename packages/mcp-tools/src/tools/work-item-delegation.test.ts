import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import {
  workItemAwaitChildrenTool,
  workItemChildResultsTool,
  workItemDelegateTool,
} from './work-item-delegation.js';

const NOW = '2026-10-10T10:00:00.000Z';

function fakeClient(response: unknown) {
  const calls: { method: string; path: string; query?: unknown; body?: unknown }[] = [];
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

function child(overrides: Record<string, unknown> = {}) {
  return {
    id: 'child12345',
    title: 'Preise bestimmen',
    status: 'review',
    statusReason: null,
    assignee: { kind: 'assistant', userId: null, name: null },
    returned: true,
    result: 'Drei Anbieter, der günstigste kostet 0,10 $ je Million Token.',
    resultTruncated: false,
    resultRefs: [{ documentId: 'page123456', title: 'Preisvergleich' }],
    criteriaMet: 1,
    criteriaTotal: 1,
    spentMicroUsd: 4_000,
    latestRun: { id: 'run1234567', status: 'completed', errorCode: null },
    closedAt: null,
    ...overrides,
  };
}

function childDetail() {
  const progress = { total: 0, open: 0, waiting: 0, review: 0, done: 0, failed: 0, cancelled: 0 };
  return {
    id: 'child12345',
    workspaceId: 'ws12345678',
    title: 'Preise bestimmen',
    status: 'queued',
    statusReason: null,
    priority: 'normal',
    requester: { kind: 'assistant', userId: 'user123456', name: 'Johanna' },
    assignee: { kind: 'assistant', userId: null, name: null },
    dueAt: null,
    parentId: 'item1234567',
    childCount: 0,
    runCount: 0,
    criteriaMet: 0,
    criteriaTotal: 0,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    goal: 'Die Preise der drei Anbieter bestimmen.',
    acceptanceCriteria: [],
    result: null,
    budgetMicroUsd: 100_000,
    writeMode: 'direct',
    agentProfile: null,
    effectiveBudgetMicroUsd: 100_000,
    spentMicroUsd: 0,
    subtreeSpentMicroUsd: 0,
    budgetRemainingMicroUsd: 100_000,
    budgetLimitedBy: null,
    childProgress: progress,
    awaiting: null,
    parent: { id: 'item1234567', title: 'Provider vergleichen' },
    contextRefs: [],
    resultRefs: [],
    children: [],
    runs: [],
    events: [],
    checkpointCount: 0,
    latestCheckpointAt: null,
    resultFields: [],
    structuredResult: null,
    workflow: null,
  };
}

describe('delegation tools (issue #144)', () => {
  it('reads the children with the ids joined into one query parameter', async () => {
    const { client, calls } = fakeClient({
      workItemId: 'item1234567',
      children: [
        child(),
        child({ id: 'child67890', status: 'working', returned: false, result: null }),
      ],
      awaiting: {
        childIds: ['child12345', 'child67890'],
        pendingChildIds: ['child67890'],
        runId: 'run7654321',
        since: NOW,
      },
    });
    const result = await workItemChildResultsTool.run(client, {
      workItemId: 'item1234567',
      childIds: ['child12345', 'child67890'],
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/work-items/item1234567/children/results',
      query: { childIds: 'child12345,child67890' },
    });
    expect(result.text).toContain('1 von 2');
    expect(result.text).toContain('Wartet auf 1 davon.');
    expect(result.text).toContain('Ergebnis: Drei Anbieter');
    expect(result.text).toContain('Preisvergleich (id: page123456)');
  });

  it('pauses the run only when something is waited for', async () => {
    const waiting = fakeClient({
      waiting: true,
      awaiting: {
        childIds: ['child12345'],
        pendingChildIds: ['child12345'],
        runId: null,
        since: NOW,
      },
      results: [],
    });
    const paused = await workItemAwaitChildrenTool.run(waiting.client, {
      workItemId: 'item1234567',
    });
    expect(waiting.calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/work-items/item1234567/await-children',
      body: {},
    });
    expect(paused.pausesRun).toBe(true);

    const back = fakeClient({ waiting: false, awaiting: null, results: [child()] });
    const done = await workItemAwaitChildrenTool.run(back.client, {
      workItemId: 'item1234567',
      childIds: ['child12345'],
    });
    expect(done.pausesRun).toBeUndefined();
    expect(done.text).toContain('Alle sind schon zurück');
  });

  it('reports a start that was refused without failing the delegation', async () => {
    const { client, calls } = fakeClient({
      workItem: childDetail(),
      run: null,
      startRefused: 'work_item_sibling_writing',
    });
    const result = await workItemDelegateTool.run(client, {
      workItemId: 'item1234567',
      title: 'Preise bestimmen',
      goal: 'Die Preise der drei Anbieter bestimmen.',
      writeMode: 'direct',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/work-items/item1234567/delegate',
      body: { title: 'Preise bestimmen', writeMode: 'direct' },
    });
    expect(result.text).toContain('work_item_sibling_writing');
  });
});
