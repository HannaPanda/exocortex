'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EvalAttempt, type EvalRun } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  ErrorState,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import {
  useCancelEvalRun,
  useDeleteEvalRun,
  useEvalComparison,
  useEvalRun,
  useEvalRuns,
} from '@/lib/api/eval-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { useDestructiveConfirmDialog } from '../editor/destructive-confirm';
import { runInspectorHref } from '../runs/run-links';
import { Section } from '../work-items/work-item-sections';

import { EvalAttemptDialog } from './eval-attempt-dialog';
import { EvalComparisonTable } from './eval-comparison-table';
import { outcomeVariant, useEvalWording } from './eval-labels';

const NONE = '__none__';

/**
 * One eval run (issue #146, ADR-074): how far it is, the comparison by case
 * and variant, and every attempt with what it cost and how it went. Another
 * run of the same cases can be laid beside it, which is how a change to a
 * prompt or a model is judged against the measurement before it.
 */
export function EvalRunDetail({
  workspaceId,
  evalRunId,
}: {
  workspaceId: string;
  evalRunId: string;
}) {
  const t = useTranslations('evals.run');
  const query = useEvalRun(evalRunId);
  const workspace = useWorkspaceDetail(workspaceId);
  if (query.isPending) return <LoadingState variant="skeleton" rows={8} label={t('loading')} />;
  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }
  const role = workspace.data?.role ?? null;
  return (
    <RunView
      workspaceId={workspaceId}
      run={query.data.run}
      attempts={query.data.attempts}
      comparison={query.data.comparison}
      canManage={role !== null && role !== 'GUEST'}
    />
  );
}

function RunView({
  workspaceId,
  run,
  attempts,
  comparison,
  canManage,
}: {
  workspaceId: string;
  run: EvalRun;
  attempts: readonly EvalAttempt[];
  comparison: Parameters<typeof EvalComparisonTable>[0]['comparison'];
  canManage: boolean;
}) {
  const t = useTranslations('evals.run');
  const wording = useEvalWording();
  const router = useRouter();
  const cancel = useCancelEvalRun(workspaceId);
  const remove = useDeleteEvalRun(workspaceId);
  const confirmDialog = useDestructiveConfirmDialog();
  const [baseline, setBaseline] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<EvalAttempt | null>(null);
  const others = useEvalRuns(workspaceId).data?.runs.filter((entry) => entry.id !== run.id) ?? [];
  const compared = useEvalComparison(baseline === null ? [] : [baseline, run.id]);
  const open = run.counts.queued + run.counts.running;

  return (
    <AppPage maxWidth="max-w-6xl" className="flex flex-col gap-6" data-testid="eval-run">
      {confirmDialog.element}
      <Link
        href={`/arbeitsbereich/${workspaceId}/evals`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="exocortex-page-title">
            {run.label ?? wording.format.moment(run.createdAt)}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('summary', {
              finished: run.counts.finished,
              total: run.counts.total,
              passed: run.counts.passed,
              cost: wording.format.money(run.costMicroUsd),
            })}
          </p>
          {open > 0 ? (
            <p className="text-meta text-muted-foreground">{t('running', { count: open })}</p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            {open > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
                data-testid="eval-run-cancel"
              >
                {t('cancel')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                void confirmDialog
                  .confirm({
                    title: t('deleteTitle'),
                    description: t('deleteDescription'),
                    confirmLabel: t('delete'),
                  })
                  .then((confirmed) => {
                    if (!confirmed) return;
                    remove.mutate(run.id, {
                      onSuccess: () => router.push(`/arbeitsbereich/${workspaceId}/evals`),
                    });
                  });
              }}
            >
              {t('delete')}
            </Button>
          </div>
        ) : null}
      </div>

      <Section
        title={t('comparisonTitle')}
        action={
          others.length === 0 ? null : (
            <div className="flex items-center gap-2">
              <Label htmlFor="eval-run-baseline" className="text-xs text-muted-foreground">
                {t('compareWith')}
              </Label>
              <Select
                value={baseline ?? NONE}
                onValueChange={(next) => setBaseline(next === NONE || next === null ? null : next)}
              >
                <SelectTrigger id="eval-run-baseline" className="h-8 w-56">
                  <SelectValue>
                    {() => {
                      const chosen = others.find((entry) => entry.id === baseline);
                      return chosen === undefined
                        ? t('compareNone')
                        : (chosen.label ?? wording.format.moment(chosen.createdAt));
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('compareNone')}</SelectItem>
                  {others.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label ?? wording.format.moment(entry.createdAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        }
      >
        <EvalComparisonTable
          comparison={baseline !== null && compared.data !== undefined ? compared.data : comparison}
        />
      </Section>

      <Section title={t('attemptsTitle')}>
        <AttemptTable workspaceId={workspaceId} attempts={attempts} onReview={setReviewing} />
      </Section>

      <EvalAttemptDialog
        attempt={reviewing}
        canReview={canManage}
        onOpenChange={(next) => {
          if (!next) setReviewing(null);
        }}
      />
    </AppPage>
  );
}

function AttemptTable({
  workspaceId,
  attempts,
  onReview,
}: {
  workspaceId: string;
  attempts: readonly EvalAttempt[];
  onReview: (attempt: EvalAttempt) => void;
}) {
  const t = useTranslations('evals.run');
  const wording = useEvalWording();
  return (
    <Table narrow="list" data-testid="eval-attempts">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.attempt')}</TableHead>
          <TableHead>{t('columns.outcome')}</TableHead>
          <TableHead>{t('columns.duration')}</TableHead>
          <TableHead>{t('columns.cost')}</TableHead>
          <TableHead>{t('columns.tools')}</TableHead>
          <TableHead>{t('columns.review')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {attempts.map((attempt) => {
          const metrics = attempt.metrics;
          return (
            <TableRow key={attempt.id} data-testid="eval-attempt-row">
              <TableCell cell="title">
                <button
                  type="button"
                  className="text-left font-medium hover:underline"
                  onClick={() => onReview(attempt)}
                >
                  {attempt.caseName}
                </button>
                <div className="text-xs text-muted-foreground">
                  {t('variantRepetition', {
                    variant: attempt.variantLabel,
                    repetition: attempt.repetition,
                  })}
                </div>
              </TableCell>
              <TableCell label={t('columns.outcome')} className="text-sm">
                {attempt.outcome === null ? (
                  <Badge variant="secondary">{wording.status(attempt.status)}</Badge>
                ) : (
                  <Badge variant={outcomeVariant(attempt.outcome)}>
                    {wording.outcome(attempt.outcome)}
                  </Badge>
                )}
                {attempt.errorCode === null ? null : (
                  <div className="mt-1 font-mono text-meta text-muted-foreground">
                    {attempt.errorCode}
                  </div>
                )}
              </TableCell>
              <TableCell label={t('columns.duration')} className="text-sm text-muted-foreground">
                {metrics?.durationMs == null ? '–' : wording.format.duration(metrics.durationMs)}
              </TableCell>
              <TableCell label={t('columns.cost')} className="text-sm text-muted-foreground">
                {metrics?.costMicroUsd == null
                  ? '–'
                  : metrics.costEstimated
                    ? t('estimated', { cost: wording.format.money(metrics.costMicroUsd) })
                    : wording.format.money(metrics.costMicroUsd)}
              </TableCell>
              <TableCell label={t('columns.tools')} className="text-sm text-muted-foreground">
                {metrics === null
                  ? '–'
                  : t('toolCalls', { count: metrics.toolCalls, failed: metrics.failedToolCalls })}
              </TableCell>
              <TableCell label={t('columns.review')} className="text-sm">
                {attempt.review?.verdict == null ? (
                  attempt.status === 'finished' ? (
                    <Button variant="ghost" size="sm" onClick={() => onReview(attempt)}>
                      {t('reviewAction')}
                    </Button>
                  ) : (
                    '–'
                  )
                ) : (
                  <Badge variant={outcomeVariant(attempt.review.verdict)}>
                    {wording.outcome(attempt.review.verdict)}
                    {attempt.review.score === null ? '' : ` · ${attempt.review.score}/5`}
                  </Badge>
                )}
                {attempt.aiRunId === null ? null : (
                  <Link
                    href={runInspectorHref(workspaceId, attempt.aiRunId)}
                    className="ml-2 text-xs text-muted-foreground hover:underline"
                  >
                    {t('inspect')}
                  </Link>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
