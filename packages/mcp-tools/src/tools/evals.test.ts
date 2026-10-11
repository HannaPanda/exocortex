import { describe, expect, it } from 'vitest';

import { type ExocortexApiClient } from '../client.js';

import { EVAL_TOOLS } from './evals.js';

const NOW = '2026-10-11T10:00:00.000Z';

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

function tool(name: string) {
  const found = EVAL_TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const run = {
  id: 'evalrun12345',
  workspaceId: 'ws12345678',
  label: 'Flash gegen GLM',
  suite: 'regression',
  variants: [{ modelSlug: 'a/b', reasoningLevel: 'none', providerRouting: null, label: 'A' }],
  repetitions: 1,
  caseCount: 1,
  counts: {
    total: 1,
    queued: 0,
    running: 0,
    finished: 1,
    cancelled: 0,
    passed: 1,
    failed: 0,
    invariantViolated: 0,
    error: 0,
  },
  costMicroUsd: 1_200,
  createdBy: null,
  createdAt: NOW,
  finishedAt: NOW,
};

const attempt = {
  id: 'attempt12345',
  evalRunId: run.id,
  caseId: 'case12345678',
  caseName: 'Plan erstellen',
  caseRevision: 2,
  replayMode: 'read_only',
  variant: run.variants[0],
  variantLabel: 'A',
  repetition: 1,
  status: 'finished',
  outcome: 'passed',
  errorCode: null,
  aiRunId: 'airun1234567',
  conversationId: null,
  metrics: null,
  assertions: [
    {
      id: 'adr',
      kind: 'answer_contains',
      role: 'criterion',
      passed: true,
      actual: null,
      decidedBy: 'system',
    },
  ],
  answer: 'Plan mit ADR-063',
  artifacts: null,
  review: null,
  createdAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
};

describe('the eval tools (issue #146)', () => {
  it('keep every write off the built-in AI', () => {
    for (const entry of EVAL_TOOLS) {
      expect(entry.domain).toBe('evals');
      if (entry.mutating) expect(entry.surfaces).toEqual(['mcp']);
      else expect(entry.surfaces).toEqual(['mcp', 'ai']);
    }
  });

  it('start a run with its variants and say what it started', async () => {
    const { client, calls } = fakeClient({
      run,
      attempts: [attempt],
      comparison: { runs: [run], cases: [], variants: [], cells: [] },
    });
    const result = await tool('exo_eval_run_start').run(client, {
      workspaceId: 'ws12345678',
      suite: 'regression',
      variants: [{ modelSlug: 'a/b' }],
      repetitions: 1,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/workspaces/ws12345678/eval-runs',
      body: { suite: 'regression', repetitions: 1 },
    });
    expect(result.text).toContain('Flash gegen GLM');
    expect(result.text).toContain('1 bestanden');
  });

  it('read an attempt with its checks and its answer', async () => {
    const { client, calls } = fakeClient({ attempt });
    const result = await tool('exo_eval_attempt_get').run(client, {
      attemptId: 'attempt12345',
    });
    expect(calls[0]?.path).toBe('/api/eval-attempts/attempt12345');
    expect(result.text).toContain('✓ Kriterium adr');
    expect(result.text).toContain('Plan mit ADR-063');
  });

  it('compare runs through one query parameter', async () => {
    const { client, calls } = fakeClient({ runs: [run], cases: [], variants: [], cells: [] });
    await tool('exo_eval_compare').run(client, { runIds: ['evalrun12345', 'evalrun67890'] });
    expect(calls[0]).toMatchObject({
      path: '/api/eval-comparison',
      query: { runIds: 'evalrun12345,evalrun67890' },
    });
  });
});
