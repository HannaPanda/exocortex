'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EvalCase, type EvalRun } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useEvalCases, useEvalRuns } from '@/lib/api/eval-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { Section } from '../work-items/work-item-sections';

import { EvalCaseDialog } from './eval-case-dialog';
import { useEvalWording } from './eval-labels';
import { EvalStartDialog } from './eval-start-dialog';

/**
 * Agent evals of one workspace (issue #146, ADR-074).
 *
 * Two lists on one screen, because they answer the two questions in the
 * order a person asks them: which tasks are kept to measure the assistant
 * with, and how did the last measurements go.
 */
export function EvalsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('evals.list');
  const workspace = useWorkspaceDetail(workspaceId);
  const cases = useEvalCases(workspaceId);
  const runs = useEvalRuns(workspaceId);
  const [creating, setCreating] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const role = workspace.data?.role ?? null;
  const canManage = role !== null && role !== 'GUEST';
  const caseList = cases.data?.cases ?? [];

  return (
    <AppPage maxWidth="max-w-5xl" className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(true)} data-testid="eval-case-new">
              {t('newCase')}
            </Button>
            <Button
              onClick={() => setStarting(true)}
              disabled={caseList.length === 0}
              data-testid="eval-run-start"
            >
              {t('startRun')}
            </Button>
          </div>
        ) : null}
      </div>

      <Section title={t('casesTitle')}>
        {cases.isPending ? (
          <LoadingState variant="skeleton" rows={3} label={t('loadingCases')} />
        ) : cases.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void cases.refetch()} />
        ) : caseList.length === 0 ? (
          <EmptyState title={t('casesEmptyTitle')} description={t('casesEmptyDescription')} />
        ) : (
          <CaseTable workspaceId={workspaceId} cases={caseList} />
        )}
      </Section>

      <Section title={t('runsTitle')}>
        {runs.isPending ? (
          <LoadingState variant="skeleton" rows={3} label={t('loadingRuns')} />
        ) : runs.isError ? (
          <ErrorState title={t('loadFailed')} onRetry={() => void runs.refetch()} />
        ) : runs.data.runs.length === 0 ? (
          <EmptyState title={t('runsEmptyTitle')} description={t('runsEmptyDescription')} />
        ) : (
          <RunTable workspaceId={workspaceId} runs={runs.data.runs} />
        )}
      </Section>

      <EvalCaseDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
        evalCase={null}
      />
      <EvalStartDialog
        open={starting}
        onOpenChange={setStarting}
        workspaceId={workspaceId}
        cases={caseList}
        suites={cases.data?.suites ?? []}
      />
    </AppPage>
  );
}

function CaseTable({ workspaceId, cases }: { workspaceId: string; cases: readonly EvalCase[] }) {
  const t = useTranslations('evals.list');
  const wording = useEvalWording();
  return (
    <Table narrow="list" data-testid="eval-cases">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.case')}</TableHead>
          <TableHead>{t('columns.mode')}</TableHead>
          <TableHead>{t('columns.checks')}</TableHead>
          <TableHead>{t('columns.attempts')}</TableHead>
          <TableHead>{t('columns.lastAttempt')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {cases.map((evalCase) => (
          <TableRow key={evalCase.id} data-testid="eval-case-row">
            <TableCell cell="title">
              <Link
                href={`/arbeitsbereich/${workspaceId}/evals/faelle/${evalCase.id}`}
                className="font-medium hover:underline"
              >
                {evalCase.name}
              </Link>
              {evalCase.suite === null ? null : (
                <Badge variant="muted" className="ml-2">
                  {evalCase.suite}
                </Badge>
              )}
            </TableCell>
            <TableCell label={t('columns.mode')} className="text-sm">
              {wording.mode(evalCase.replayMode)}
            </TableCell>
            <TableCell label={t('columns.checks')} className="text-sm text-muted-foreground">
              {t('checksCount', {
                invariants: evalCase.invariants.length,
                criteria: evalCase.criteria.length,
              })}
            </TableCell>
            <TableCell label={t('columns.attempts')} className="text-sm text-muted-foreground">
              {wording.format.count(evalCase.attemptCount)}
            </TableCell>
            <TableCell label={t('columns.lastAttempt')} className="text-sm text-muted-foreground">
              {evalCase.lastAttemptAt === null
                ? '–'
                : wording.format.moment(evalCase.lastAttemptAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunTable({ workspaceId, runs }: { workspaceId: string; runs: readonly EvalRun[] }) {
  const t = useTranslations('evals.list');
  const wording = useEvalWording();
  return (
    <Table narrow="list" data-testid="eval-runs">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.run')}</TableHead>
          <TableHead>{t('columns.progress')}</TableHead>
          <TableHead>{t('columns.passed')}</TableHead>
          <TableHead>{t('columns.cost')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const open = run.counts.queued + run.counts.running;
          return (
            <TableRow key={run.id} data-testid="eval-run-row">
              <TableCell cell="title">
                <Link
                  href={`/arbeitsbereich/${workspaceId}/evals/${run.id}`}
                  className="font-medium hover:underline"
                >
                  {run.label ?? wording.format.moment(run.createdAt)}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {t('runShape', {
                    cases: run.caseCount,
                    variants: run.variants.length,
                    repetitions: run.repetitions,
                  })}
                </div>
              </TableCell>
              <TableCell label={t('columns.progress')} className="text-sm">
                {open > 0 ? (
                  <Badge variant="secondary">{t('openCount', { count: open })}</Badge>
                ) : (
                  t('doneCount', { finished: run.counts.finished, total: run.counts.total })
                )}
              </TableCell>
              <TableCell label={t('columns.passed')} className="text-sm">
                {t('passedCount', { passed: run.counts.passed, finished: run.counts.finished })}
                {run.counts.invariantViolated > 0 ? (
                  <Badge variant="destructive" className="ml-2">
                    {t('violatedCount', { count: run.counts.invariantViolated })}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell label={t('columns.cost')} className="text-sm text-muted-foreground">
                {wording.format.money(run.costMicroUsd)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
