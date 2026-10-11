import { describe, expect, it } from 'vitest';

import { type EvalAttempt, type EvalRun } from '@exocortex/contracts';

import { buildComparison } from './eval-comparison';

const run = (id: string): EvalRun => ({
  id,
  workspaceId: 'ws-1',
  label: null,
  suite: null,
  variants: [],
  repetitions: 1,
  caseCount: 1,
  counts: {
    total: 0,
    queued: 0,
    running: 0,
    finished: 0,
    cancelled: 0,
    passed: 0,
    failed: 0,
    invariantViolated: 0,
    error: 0,
  },
  costMicroUsd: 0,
  createdBy: null,
  createdAt: '2026-10-11T10:00:00.000Z',
  finishedAt: null,
});

function attempt(overrides: Partial<EvalAttempt> & { cost?: number | null }): EvalAttempt {
  const { cost = 100, ...rest } = overrides;
  return {
    id: 'a',
    evalRunId: 'run-1',
    caseId: 'case-1',
    caseName: 'Plan',
    caseRevision: 1,
    replayMode: 'read_only',
    variant: { modelSlug: 'm', reasoningLevel: 'none', providerRouting: null, label: null },
    variantLabel: 'm',
    repetition: 1,
    status: 'finished',
    outcome: 'passed',
    errorCode: null,
    aiRunId: null,
    conversationId: null,
    metrics: {
      runStatus: 'completed',
      errorCode: null,
      durationMs: 1_000,
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costMicroUsd: cost,
      costEstimated: false,
      usedOwnKey: false,
      turns: 1,
      toolCalls: 2,
      failedToolCalls: 0,
      tools: {},
      providers: [],
      providerSwitches: 0,
      contextChars: null,
      contextTokens: null,
      compactions: 0,
      humanCheckpoints: 0,
      proposedChanges: 0,
      answerChars: 0,
    },
    assertions: [
      {
        id: 'x',
        kind: 'answer_contains',
        role: 'criterion',
        passed: true,
        actual: null,
        decidedBy: 'system',
        text: null,
      },
    ],
    answer: null,
    artifacts: null,
    review: null,
    createdAt: '2026-10-11T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...rest,
  };
}

describe('buildComparison (issue #146)', () => {
  it('groups by run, case and variant, and averages over what has the figure', () => {
    const comparison = buildComparison(
      [run('run-1')],
      [
        attempt({ id: 'a1' }),
        attempt({ id: 'a2', outcome: 'failed', cost: null }),
        attempt({ id: 'a3', variantLabel: 'n', status: 'running', outcome: null }),
      ],
    );
    expect(comparison.cases).toEqual([{ key: 'Plan', caseId: 'case-1', name: 'Plan' }]);
    expect(comparison.variants).toEqual(['m', 'n']);
    const m = comparison.cells.find((cell) => cell.variantLabel === 'm')!;
    expect(m).toMatchObject({
      attempts: 2,
      finished: 2,
      passed: 1,
      meanCostMicroUsd: 100,
      totalCostMicroUsd: 100,
      meanToolCalls: 2,
    });
    expect(m.assertionPassRates).toEqual([
      { id: 'x', kind: 'answer_contains', passed: 2, decided: 2 },
    ]);
    const n = comparison.cells.find((cell) => cell.variantLabel === 'n')!;
    expect(n).toMatchObject({ attempts: 1, finished: 0, meanCostMicroUsd: null });
  });

  it('puts two runs of the same case side by side', () => {
    const comparison = buildComparison(
      [run('run-1'), run('run-2')],
      [attempt({ id: 'a1' }), attempt({ id: 'b1', evalRunId: 'run-2', outcome: 'failed' })],
    );
    expect(comparison.cells.map((cell) => [cell.evalRunId, cell.passed])).toEqual([
      ['run-1', 1],
      ['run-2', 0],
    ]);
  });

  it('counts reviews and their scores', () => {
    const review = {
      verdict: 'passed' as const,
      score: 4,
      note: null,
      reviewedBy: null,
      reviewedAt: '2026-10-11T11:00:00.000Z',
    };
    const comparison = buildComparison(
      [run('run-1')],
      [
        attempt({ id: 'a1', review }),
        attempt({ id: 'a2', review: { ...review, verdict: 'failed', score: 2 } }),
      ],
    );
    expect(comparison.cells[0]).toMatchObject({ reviewed: 2, reviewedPassed: 1, meanScore: 3 });
  });
});
