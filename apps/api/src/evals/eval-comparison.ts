import {
  type EvalAttempt,
  type EvalComparison,
  type EvalComparisonCell,
  type EvalRun,
} from '@exocortex/contracts';

/**
 * The comparison of eval runs (issue #146): cases as rows, variants as
 * columns, one cell per run. Pure, so the arithmetic is tested without a
 * database. Means are over the finished attempts that have the figure, never
 * over zeros invented for the ones that do not.
 */

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return present.reduce((total, value) => total + value, 0) / present.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function cellOf(evalRunId: string, caseKey: string, variantLabel: string, attempts: EvalAttempt[]) {
  const finished = attempts.filter((attempt) => attempt.status === 'finished');
  const metrics = finished.flatMap((attempt) =>
    attempt.metrics === null ? [] : [attempt.metrics],
  );
  const reviewed = finished.filter((attempt) => attempt.review?.verdict != null);

  const rates = new Map<string, { kind: string; passed: number; decided: number }>();
  for (const attempt of finished) {
    for (const result of attempt.assertions) {
      const entry = rates.get(result.id) ?? { kind: result.kind, passed: 0, decided: 0 };
      if (result.passed !== null) {
        entry.decided += 1;
        if (result.passed) entry.passed += 1;
      }
      rates.set(result.id, entry);
    }
  }

  const cell: EvalComparisonCell = {
    evalRunId,
    caseKey,
    variantLabel,
    attempts: attempts.length,
    finished: finished.length,
    passed: finished.filter((attempt) => attempt.outcome === 'passed').length,
    invariantViolated: finished.filter((attempt) => attempt.outcome === 'invariant_violated')
      .length,
    reviewedPassed: reviewed.filter((attempt) => attempt.review?.verdict === 'passed').length,
    reviewed: reviewed.length,
    meanDurationMs: mean(metrics.map((metric) => metric.durationMs)),
    meanCostMicroUsd: mean(metrics.map((metric) => metric.costMicroUsd)),
    meanToolCalls: mean(metrics.map((metric) => metric.toolCalls)),
    meanInputTokens: mean(metrics.map((metric) => metric.inputTokens)),
    meanOutputTokens: mean(metrics.map((metric) => metric.outputTokens)),
    meanScore: mean(reviewed.map((attempt) => attempt.review?.score ?? null)),
    totalCostMicroUsd: sum(metrics.map((metric) => metric.costMicroUsd ?? 0)),
    failedToolCalls: sum(metrics.map((metric) => metric.failedToolCalls)),
    providerSwitches: sum(metrics.map((metric) => metric.providerSwitches)),
    humanCheckpoints: sum(metrics.map((metric) => metric.humanCheckpoints)),
    assertionPassRates: [...rates].map(([id, entry]) => ({ id, ...entry })),
  };
  return cell;
}

/**
 * Cases are matched across runs by name: an imported suite gives the same
 * case a different id in another workspace, and a renamed case is, for a
 * comparison, a different question.
 */
export function buildComparison(runs: readonly EvalRun[], attempts: readonly EvalAttempt[]) {
  const cases: EvalComparison['cases'] = [];
  const variants: string[] = [];
  const groups = new Map<string, EvalAttempt[]>();

  const ordered = [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const attempt of ordered) {
    if (!cases.some((entry) => entry.key === attempt.caseName)) {
      cases.push({ key: attempt.caseName, caseId: attempt.caseId, name: attempt.caseName });
    }
    if (!variants.includes(attempt.variantLabel)) variants.push(attempt.variantLabel);
    const key = JSON.stringify([attempt.evalRunId, attempt.caseName, attempt.variantLabel]);
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }

  const cells: EvalComparisonCell[] = [];
  for (const run of runs) {
    for (const entry of cases) {
      for (const variant of variants) {
        const group = groups.get(JSON.stringify([run.id, entry.key, variant]));
        if (group !== undefined) cells.push(cellOf(run.id, entry.key, variant, group));
      }
    }
  }
  return { runs: [...runs], cases, variants, cells } satisfies EvalComparison;
}
