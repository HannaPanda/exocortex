'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type EvalAssertion,
  type EvalAssertionResult,
  type EvalAttemptStatus,
  type EvalOutcome,
  type EvalReplayMode,
} from '@exocortex/contracts';

import { useRunFormat } from '../runs/run-inspector-format';

/**
 * The words an eval is shown in (issue #146), shared by the lists, the run
 * and the case. A check is described in one sentence from its kind and its
 * fields, so the case and an attempt's result say the same thing.
 */
export function useEvalWording() {
  const t = useTranslations('evals.labels');
  const format = useRunFormat();
  return React.useMemo(() => {
    const mode = (value: EvalReplayMode): string => t(`mode.${value}`);
    const modeHint = (value: EvalReplayMode): string => t(`modeHint.${value}`);
    const status = (value: EvalAttemptStatus): string => t(`status.${value}`);
    const outcome = (value: EvalOutcome): string => t(`outcome.${value}`);
    const kind = (value: EvalAssertion['kind']): string => t(`kind.${value}`);
    const limit = (max: number | null): string =>
      max === null ? t('unbounded') : format.count(max);

    const describe = (assertion: EvalAssertion): string => {
      switch (assertion.kind) {
        case 'answer_contains':
        case 'answer_excludes':
          return t(`summary.${assertion.kind}`, { text: assertion.text });
        case 'answer_matches':
          return t('summary.answer_matches', {
            pattern: assertion.pattern,
            min: format.count(assertion.min),
            max: limit(assertion.max),
          });
        case 'tool_called':
          return t('summary.tool_called', {
            tool: assertion.tool,
            min: format.count(assertion.min),
            max: limit(assertion.max),
          });
        case 'tool_not_called':
          return t('summary.tool_not_called', { tool: assertion.tool });
        case 'max_tool_calls':
        case 'max_failed_tool_calls':
          return t(`summary.${assertion.kind}`, { max: format.count(assertion.max) });
        case 'max_cost':
          return t('summary.max_cost', { max: format.money(assertion.maxMicroUsd) });
        case 'max_duration':
          return t('summary.max_duration', { max: format.duration(assertion.maxSeconds * 1_000) });
        case 'no_changes':
          return t('summary.no_changes');
        case 'page_contains':
        case 'page_excludes':
          return t(`summary.${assertion.kind}`, { page: assertion.page, text: assertion.text });
        case 'pages_created':
        case 'proposed_changes':
          return t(`summary.${assertion.kind}`, {
            min: format.count(assertion.min),
            max: limit(assertion.max),
          });
        case 'manual':
          return assertion.text;
      }
    };

    /** What a result found, when it has a figure to show. */
    const actual = (result: EvalAssertionResult): string | null => {
      if (result.actual === null) return null;
      if (result.actual === 'missing') return t('actualMissing');
      if (typeof result.actual === 'string') return result.actual;
      if (result.kind === 'max_cost') return format.money(result.actual);
      if (result.kind === 'max_duration') return format.duration(result.actual * 1_000);
      return format.count(result.actual);
    };

    return { mode, modeHint, status, outcome, kind, describe, actual, format };
  }, [format, t]);
}

export type EvalWording = ReturnType<typeof useEvalWording>;

/** The badge variant an outcome is shown in; the colour comes from the design tokens. */
export function outcomeVariant(
  outcome: EvalOutcome | null,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (outcome === 'passed') return 'default';
  if (outcome === 'failed' || outcome === 'invariant_violated') return 'destructive';
  if (outcome === 'error') return 'outline';
  return 'secondary';
}
