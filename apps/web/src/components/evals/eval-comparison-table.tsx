'use client';

import { useTranslations } from 'next-intl';

import { type EvalComparison, type EvalComparisonCell } from '@exocortex/contracts';
import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { type EvalWording, useEvalWording } from './eval-labels';

/**
 * The comparison of one or more eval runs (issue #146): a row per case, a
 * column per variant, and in each cell one line per run. The pass count is
 * first because it is what the comparison is for; the means after it say
 * what the passes cost.
 */
export function EvalComparisonTable({ comparison }: { comparison: EvalComparison }) {
  const t = useTranslations('evals.comparison');
  const wording = useEvalWording();
  if (comparison.cells.length === 0) {
    return <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />;
  }
  return (
    <Table data-testid="eval-comparison">
      <TableHeader>
        <TableRow>
          <TableHead>{t('case')}</TableHead>
          {comparison.variants.map((variant) => (
            <TableHead key={variant}>{variant}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {comparison.cases.map((entry) => (
          <TableRow key={entry.key}>
            <TableCell className="align-top font-medium">{entry.name}</TableCell>
            {comparison.variants.map((variant) => (
              <TableCell key={variant} className="align-top">
                <VariantCell
                  comparison={comparison}
                  caseKey={entry.key}
                  variant={variant}
                  wording={wording}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The cell of one case and one variant: a block per run that has attempts there. */
function VariantCell({
  comparison,
  caseKey,
  variant,
  wording,
}: {
  comparison: EvalComparison;
  caseKey: string;
  variant: string;
  wording: EvalWording;
}) {
  const several = comparison.runs.length > 1;
  return (
    <div className="flex flex-col gap-2">
      {comparison.runs.map((run) => {
        const cell = comparison.cells.find(
          (candidate) =>
            candidate.evalRunId === run.id &&
            candidate.caseKey === caseKey &&
            candidate.variantLabel === variant,
        );
        if (cell === undefined) return null;
        return (
          <CellLines
            key={run.id}
            cell={cell}
            runLabel={several ? (run.label ?? wording.format.moment(run.createdAt)) : null}
            wording={wording}
          />
        );
      })}
    </div>
  );
}

function CellLines({
  cell,
  runLabel,
  wording,
}: {
  cell: EvalComparisonCell;
  runLabel: string | null;
  wording: EvalWording;
}) {
  const t = useTranslations('evals.comparison');
  const { format } = wording;
  return (
    <div className="flex flex-col gap-0.5 text-sm" data-testid="eval-comparison-cell">
      {runLabel === null ? null : (
        <span className="text-meta text-muted-foreground">{runLabel}</span>
      )}
      <span className="font-medium tabular-nums">
        {t('passed', { passed: cell.passed, finished: cell.finished })}
      </span>
      {cell.invariantViolated > 0 ? (
        <span className="text-xs text-destructive">
          {t('violated', { count: cell.invariantViolated })}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground tabular-nums">
        {[
          cell.meanDurationMs === null ? null : format.duration(cell.meanDurationMs),
          cell.meanCostMicroUsd === null ? null : format.money(cell.meanCostMicroUsd),
          cell.meanToolCalls === null
            ? null
            : t('meanCalls', { calls: format.count(Math.round(cell.meanToolCalls * 10) / 10) }),
        ]
          .filter((part) => part !== null)
          .join(' · ')}
      </span>
      {cell.reviewed > 0 ? (
        <span className="text-xs text-muted-foreground">
          {t('reviewed', {
            passed: cell.reviewedPassed,
            reviewed: cell.reviewed,
            score:
              cell.meanScore === null ? '–' : format.count(Math.round(cell.meanScore * 10) / 10),
          })}
        </span>
      ) : null}
    </div>
  );
}
