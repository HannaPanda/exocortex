import { describe, expect, it } from 'vitest';

import { type PrismaClient } from '@exocortex/database';

import {
  type EvalHold,
  evalLimits,
  evalProviderRouting,
  evalToolDomains,
  resolveEvalHold,
} from './eval-hold';

const hold: EvalHold = {
  attemptId: 'attempt-1',
  writeMode: 'read_only',
  agentProfileId: null,
  toolDomains: ['web', 'pages'],
  budgetMicroUsd: 50_000,
  maxToolIterations: null,
  maxRunSeconds: 120,
  providerRouting: { only: ['deepinfra'] },
  pageRootId: null,
};

const snapshot = {
  name: 'Fall',
  description: null,
  suite: null,
  prompt: 'Tu etwas',
  replayMode: 'fixture',
  documentId: null,
  fixture: { pages: [{ key: 'a', title: 'A', markdown: '', parentKey: null }], startKey: 'a' },
  agentProfileId: null,
  toolDomains: null,
  budgetMicroUsd: null,
  maxToolIterations: null,
  maxRunSeconds: null,
  invariants: [],
  criteria: [],
  expectedOutcome: null,
};

function prismaWith(rows: {
  attempt?: Record<string, unknown> | null;
  sandbox?: { workspaceId: string } | null;
}): PrismaClient {
  return {
    evalAttempt: { findUnique: async () => rows.attempt ?? null },
    agentProfile: { findUnique: async () => null },
    document: { findUnique: async () => rows.sandbox ?? null },
  } as unknown as PrismaClient;
}

const run = { id: 'run-1', evalAttemptId: 'attempt-1', workspaceId: 'ws-1' };
const attempt = {
  id: 'attempt-1',
  workspaceId: 'ws-1',
  status: 'RUNNING',
  aiRunId: null,
  caseSnapshot: snapshot,
  variant: { modelSlug: 'a/b' },
  sandboxDocumentId: 'sandbox-1',
};

describe('resolveEvalHold (issue #146)', () => {
  it('leaves an ordinary run alone', async () => {
    const result = await resolveEvalHold({
      prisma: prismaWith({}),
      run: { ...run, evalAttemptId: null },
    });
    expect(result.kind).toBe('none');
  });

  it('refuses a run whose attempt is gone, finished or elsewhere', async () => {
    expect(await resolveEvalHold({ prisma: prismaWith({ attempt: null }), run })).toEqual({
      kind: 'refused',
      reason: 'attempt_missing',
    });
    expect(
      await resolveEvalHold({
        prisma: prismaWith({ attempt: { ...attempt, status: 'CANCELLED' } }),
        run,
      }),
    ).toEqual({ kind: 'refused', reason: 'attempt_not_running' });
    expect(
      await resolveEvalHold({
        prisma: prismaWith({ attempt: { ...attempt, workspaceId: 'ws-2' } }),
        run,
      }),
    ).toEqual({ kind: 'refused', reason: 'attempt_missing' });
  });

  it('confines a fixture attempt to its sandbox and refuses one without it', async () => {
    const held = await resolveEvalHold({
      prisma: prismaWith({ attempt, sandbox: { workspaceId: 'ws-1' } }),
      run,
    });
    expect(held.kind === 'held' && held.hold.pageRootId).toBe('sandbox-1');
    expect(held.kind === 'held' && held.hold.writeMode).toBe('direct');
    expect(await resolveEvalHold({ prisma: prismaWith({ attempt, sandbox: null }), run })).toEqual({
      kind: 'refused',
      reason: 'sandbox_missing',
    });
  });
});

describe('what an eval case adds to a run', () => {
  it('only ever lowers a limit', () => {
    expect(
      evalLimits(hold, { budgetMicroUsd: 100_000, maxToolIterations: 20, runBudgetMs: 600_000 }),
    ).toEqual({ budgetMicroUsd: 50_000, maxToolIterations: 20, runBudgetMs: 120_000 });
    expect(evalLimits(null, { budgetMicroUsd: 1, maxToolIterations: 2, runBudgetMs: 3 })).toEqual({
      budgetMicroUsd: 1,
      maxToolIterations: 2,
      runBudgetMs: 3,
    });
  });

  it('narrows the profile domains and keeps what the run needs', () => {
    expect(evalToolDomains(null, hold, ['changesets'])).toEqual([
      'core',
      'web',
      'pages',
      'changesets',
    ]);
    expect(evalToolDomains(['core', 'web', 'databases'], hold, [])).toEqual(['core', 'web']);
    expect(evalToolDomains(['core', 'web'], { ...hold, toolDomains: null }, [])).toEqual([
      'core',
      'web',
    ]);
    expect(evalToolDomains(null, null, [])).toBeNull();
  });

  it('lays the variant routing over the profile', () => {
    expect(evalProviderRouting({ sort: 'price', only: ['a'] }, hold)).toEqual({
      sort: 'price',
      only: ['deepinfra'],
    });
    expect(evalProviderRouting({ sort: 'price' }, null)).toEqual({ sort: 'price' });
  });
});
