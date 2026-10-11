import { describe, expect, it } from 'vitest';

import { type EvalAttemptMetrics, evalAssertionSchema } from '@exocortex/contracts';

import {
  buildMetrics,
  type EvalFacts,
  evaluateAssertions,
  type MeasuredRunRow,
  outcomeOf,
} from './eval-assertions';

const metrics: EvalAttemptMetrics = {
  runStatus: 'completed',
  errorCode: null,
  durationMs: 42_000,
  inputTokens: 1_000,
  outputTokens: 200,
  cachedInputTokens: 0,
  costMicroUsd: 1_500,
  costEstimated: false,
  usedOwnKey: false,
  turns: 3,
  toolCalls: 4,
  failedToolCalls: 1,
  tools: { exo_search: 2, exo_page_read: 2 },
  providers: ['deepinfra'],
  providerSwitches: 0,
  contextChars: 5_000,
  contextTokens: 1_300,
  compactions: 0,
  humanCheckpoints: 0,
  proposedChanges: 0,
  answerChars: 120,
};

const facts: EvalFacts = {
  runStatus: 'completed',
  answer: 'Der Plan nennt ADR-063.\n1. Router\n2. Grenze\n3. Tests',
  metrics,
  pages: { notes: '# Notizen\n\nNeu: Abschnitt B', gone: null },
  changedPages: 1,
  createdPages: 0,
};

const check = (value: Record<string, unknown>) => evalAssertionSchema.parse(value);

function decided(value: Record<string, unknown>, overrides: Partial<EvalFacts> = {}) {
  const [result] = evaluateAssertions(
    { invariants: [], criteria: [check(value)] },
    { ...facts, ...overrides },
  );
  return result!;
}

describe('evaluateAssertions (issue #146)', () => {
  it('reads the answer, case-insensitively unless asked', () => {
    expect(decided({ id: 'a', kind: 'answer_contains', text: 'adr-063' }).passed).toBe(true);
    expect(
      decided({ id: 'a', kind: 'answer_contains', text: 'adr-063', caseSensitive: true }).passed,
    ).toBe(false);
    expect(decided({ id: 'a', kind: 'answer_excludes', text: 'ADR-099' }).passed).toBe(true);
  });

  it('counts pattern matches against a bound', () => {
    const steps = { id: 'n', kind: 'answer_matches', pattern: '^\\d+\\.', flags: 'm', max: 8 };
    expect(decided(steps)).toMatchObject({ passed: true, actual: 3 });
    expect(decided({ ...steps, max: 2 })).toMatchObject({ passed: false, actual: 3 });
  });

  it('reads the tools the run called', () => {
    expect(decided({ id: 't', kind: 'tool_called', tool: 'exo_search', min: 2 }).passed).toBe(true);
    expect(decided({ id: 't', kind: 'tool_not_called', tool: 'exo_page_write' }).passed).toBe(true);
    expect(decided({ id: 't', kind: 'max_tool_calls', max: 3 })).toMatchObject({
      passed: false,
      actual: 4,
    });
    expect(decided({ id: 't', kind: 'max_failed_tool_calls', max: 0 }).passed).toBe(false);
  });

  it('leaves a cost undecided when none was reported', () => {
    expect(decided({ id: 'c', kind: 'max_cost', maxMicroUsd: 2_000 }).passed).toBe(true);
    expect(
      decided(
        { id: 'c', kind: 'max_cost', maxMicroUsd: 2_000 },
        { metrics: { ...metrics, costMicroUsd: null } },
      ).passed,
    ).toBeNull();
    expect(decided({ id: 'd', kind: 'max_duration', maxSeconds: 30 })).toMatchObject({
      passed: false,
      actual: 42,
    });
  });

  it('counts every change against no_changes', () => {
    expect(decided({ id: 'n', kind: 'no_changes' })).toMatchObject({ passed: false, actual: 1 });
    expect(decided({ id: 'n', kind: 'no_changes' }, { changedPages: 0 }).passed).toBe(true);
    expect(
      decided(
        { id: 'n', kind: 'no_changes' },
        { changedPages: 0, metrics: { ...metrics, proposedChanges: 2 } },
      ).passed,
    ).toBe(false);
  });

  it('reads the final fixture pages', () => {
    expect(
      decided({ id: 'p', kind: 'page_contains', page: 'notes', text: 'abschnitt b' }).passed,
    ).toBe(true);
    expect(decided({ id: 'p', kind: 'page_contains', page: 'gone', text: 'x' })).toMatchObject({
      passed: false,
      actual: 'missing',
    });
    expect(decided({ id: 'p', kind: 'page_excludes', page: 'gone', text: 'x' }).passed).toBe(true);
  });

  it('leaves a manual check to the review', () => {
    const manual = check({ id: 'm', kind: 'manual', text: 'Plan ist umsetzbar' });
    expect(evaluateAssertions({ invariants: [], criteria: [manual] }, facts)[0]).toMatchObject({
      passed: null,
      decidedBy: 'review',
    });
    expect(
      evaluateAssertions({ invariants: [], criteria: [manual] }, facts, { m: false })[0]!.passed,
    ).toBe(false);
  });
});

describe('outcomeOf', () => {
  const invariant = {
    id: 'i',
    kind: 'no_changes',
    role: 'invariant',
    actual: null,
    decidedBy: 'system',
  } as const;
  const criterion = {
    id: 'c',
    kind: 'answer_contains',
    role: 'criterion',
    actual: null,
    decidedBy: 'system',
  } as const;

  it('puts a broken invariant above everything', () => {
    expect(
      outcomeOf('completed', [
        { ...invariant, passed: false },
        { ...criterion, passed: true },
      ]),
    ).toBe('invariant_violated');
    expect(outcomeOf('failed', [{ ...invariant, passed: false }])).toBe('invariant_violated');
  });

  it('fails a run that did not finish, and a failed criterion', () => {
    expect(outcomeOf('timed_out', [{ ...criterion, passed: true }])).toBe('failed');
    expect(outcomeOf('completed', [{ ...criterion, passed: false }])).toBe('failed');
  });

  it('lets an undecided check hold nothing up', () => {
    expect(outcomeOf('completed', [{ ...criterion, passed: null }])).toBe('passed');
  });
});

describe('buildMetrics', () => {
  const run: MeasuredRunRow = {
    status: 'COMPLETED',
    errorCode: null,
    startedAt: new Date('2026-10-11T10:00:00Z'),
    finishedAt: new Date('2026-10-11T10:00:30Z'),
    durationMs: 12_000,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    providerCostMicroUsd: null,
    estimatedCostMicroUsd: 300,
    usedOwnKey: true,
    resultText: 'Antwort',
  };
  const at = new Date('2026-10-11T10:00:01Z');
  const turn = (index: number, servedBy: string | null) => ({
    sequence: index * 10,
    kind: 'turn',
    at,
    durationMs: 100,
    data: {
      index,
      model: 'm',
      servedBy,
      eligibleProviders: 2,
      finishReason: 'stop',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      costMicroUsd: null,
      toolCalls: 1,
      reasoned: false,
      outputChars: 3,
      failureCode: null,
    },
  });
  const call = (sequence: number, toolName: string, status: string) => ({
    sequence,
    kind: 'tool_call',
    at,
    durationMs: 50,
    data: {
      iteration: 1,
      toolName,
      status,
      target: null,
      resultChars: 10,
      resultTruncated: false,
      untrustedOrigin: null,
      repeated: false,
      pausedRun: false,
    },
  });

  it('counts tools, failures and provider switches, and marks an estimated cost', () => {
    const built = buildMetrics({
      run,
      events: [
        turn(1, 'a'),
        call(11, 'exo_search', 'succeeded'),
        turn(2, 'b'),
        call(21, 'exo_search', 'failed'),
        call(22, 'exo_page_read', 'skipped'),
      ],
      humanCheckpoints: 1,
      proposedChanges: 0,
    });
    expect(built).toMatchObject({
      runStatus: 'completed',
      durationMs: 30_000,
      turns: 2,
      toolCalls: 3,
      failedToolCalls: 1,
      tools: { exo_search: 2, exo_page_read: 1 },
      providers: ['a', 'b'],
      providerSwitches: 1,
      costMicroUsd: 300,
      costEstimated: true,
      usedOwnKey: true,
      humanCheckpoints: 1,
      answerChars: 7,
    });
  });
});
