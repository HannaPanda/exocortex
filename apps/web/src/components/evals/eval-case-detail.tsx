'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type EvalAssertion, type EvalAttempt, type EvalCase } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Readout,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useDeleteEvalCase, useEvalCase } from '@/lib/api/eval-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { useDestructiveConfirmDialog } from '../editor/destructive-confirm';
import { Section } from '../work-items/work-item-sections';

import { EvalCaseDialog } from './eval-case-dialog';
import { outcomeVariant, useEvalWording } from './eval-labels';
import { EvalStartDialog } from './eval-start-dialog';

/**
 * One eval case (issue #146, ADR-074): the task, how it stays harmless, what
 * holds it, what has to be true afterwards, and how its latest attempts went
 * across every run.
 */
export function EvalCaseDetail({ workspaceId, caseId }: { workspaceId: string; caseId: string }) {
  const t = useTranslations('evals.case');
  const query = useEvalCase(caseId);
  const workspace = useWorkspaceDetail(workspaceId);
  if (query.isPending) return <LoadingState variant="skeleton" rows={6} label={t('loading')} />;
  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }
  const role = workspace.data?.role ?? null;
  return (
    <CaseView
      workspaceId={workspaceId}
      evalCase={query.data.evalCase}
      attempts={query.data.recentAttempts}
      canManage={role !== null && role !== 'GUEST'}
    />
  );
}

function CaseView({
  workspaceId,
  evalCase,
  attempts,
  canManage,
}: {
  workspaceId: string;
  evalCase: EvalCase;
  attempts: readonly EvalAttempt[];
  canManage: boolean;
}) {
  const t = useTranslations('evals.case');
  const wording = useEvalWording();
  const router = useRouter();
  const remove = useDeleteEvalCase(workspaceId);
  const confirmDialog = useDestructiveConfirmDialog();
  const [editing, setEditing] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const { format } = wording;

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-5" data-testid="eval-case">
      {confirmDialog.element}
      <Link
        href={`/arbeitsbereich/${workspaceId}/evals`}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('back')}
      </Link>

      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <h1 className="exocortex-page-title" data-testid="eval-case-heading">
            {evalCase.name}
          </h1>
          {canManage ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button size="sm" onClick={() => setStarting(true)}>
                {t('start')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t('edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={remove.isPending}
                onClick={() => {
                  void confirmDialog
                    .confirm({
                      title: t('deleteTitle', { name: evalCase.name }),
                      description: t('deleteDescription'),
                      confirmLabel: t('delete'),
                    })
                    .then((confirmed) => {
                      if (!confirmed) return;
                      remove.mutate(evalCase.id, {
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
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{wording.mode(evalCase.replayMode)}</Badge>
          {evalCase.suite === null ? null : <Badge variant="muted">{evalCase.suite}</Badge>}
          <span>{t('revision', { revision: evalCase.revision })}</span>
          {evalCase.sourceRunId === null ? null : (
            <Link
              href={`/arbeitsbereich/${workspaceId}/laeufe/${evalCase.sourceRunId}`}
              className="hover:underline"
            >
              {t('sourceRun')}
            </Link>
          )}
        </div>
        {evalCase.description === null ? null : (
          <p className="max-w-measure text-sm">{evalCase.description}</p>
        )}
        <p className="text-meta text-muted-foreground">{wording.modeHint(evalCase.replayMode)}</p>
      </div>

      <Section title={t('prompt')}>
        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{evalCase.prompt}</pre>
      </Section>

      <Section title={t('setting')}>
        <div className="flex flex-col gap-1.5">
          {evalCase.fixture === null ? (
            <Readout
              label={t('startPage')}
              value={
                evalCase.documentId === null ? (
                  t('noPage')
                ) : (
                  <Link
                    href={`/arbeitsbereich/${workspaceId}/seite/${evalCase.documentId}`}
                    className="hover:underline"
                  >
                    {evalCase.documentTitle ?? t('pageGone')}
                  </Link>
                )
              }
            />
          ) : (
            <Readout
              label={t('fixture')}
              value={evalCase.fixture.pages.map((page) => `${page.key}: ${page.title}`).join(' · ')}
              note={
                evalCase.fixture.startKey === null
                  ? t('startsOnSandbox')
                  : t('startsOn', { key: evalCase.fixture.startKey })
              }
            />
          )}
          <Readout label={t('profile')} value={evalCase.agentProfileName ?? t('noProfile')} />
          <Readout
            label={t('tools')}
            value={evalCase.toolDomains === null ? t('toolsAll') : evalCase.toolDomains.join(', ')}
          />
          <Readout
            label={t('limits')}
            value={
              [
                evalCase.budgetMicroUsd === null ? null : format.money(evalCase.budgetMicroUsd),
                evalCase.maxToolIterations === null
                  ? null
                  : t('iterations', { count: evalCase.maxToolIterations }),
                evalCase.maxRunSeconds === null
                  ? null
                  : format.duration(evalCase.maxRunSeconds * 1_000),
              ]
                .filter((part) => part !== null)
                .join(' · ') || t('noLimits')
            }
          />
        </div>
      </Section>

      <Section title={t('checks')}>
        <CheckList title={t('invariants')} checks={evalCase.invariants} />
        <CheckList title={t('criteria')} checks={evalCase.criteria} />
        {evalCase.expectedOutcome === null ? null : (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{t('expected')}</h3>
            <p className="whitespace-pre-wrap text-sm">{evalCase.expectedOutcome}</p>
          </div>
        )}
      </Section>

      <Section title={t('attempts')}>
        {attempts.length === 0 ? (
          <EmptyState title={t('attemptsEmptyTitle')} description={t('attemptsEmptyDescription')} />
        ) : (
          <Table narrow="list" data-testid="eval-case-attempts">
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.when')}</TableHead>
                <TableHead>{t('columns.variant')}</TableHead>
                <TableHead>{t('columns.outcome')}</TableHead>
                <TableHead>{t('columns.cost')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attempts.map((attempt) => (
                <TableRow key={attempt.id}>
                  <TableCell cell="title">
                    <Link
                      href={`/arbeitsbereich/${workspaceId}/evals/${attempt.evalRunId}`}
                      className="hover:underline"
                    >
                      {format.moment(attempt.createdAt)}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {t('revision', { revision: attempt.caseRevision })}
                    </div>
                  </TableCell>
                  <TableCell label={t('columns.variant')} className="text-sm">
                    {attempt.variantLabel}
                  </TableCell>
                  <TableCell label={t('columns.outcome')} className="text-sm">
                    {attempt.outcome === null ? (
                      <Badge variant="secondary">{wording.status(attempt.status)}</Badge>
                    ) : (
                      <Badge variant={outcomeVariant(attempt.outcome)}>
                        {wording.outcome(attempt.outcome)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell label={t('columns.cost')} className="text-sm text-muted-foreground">
                    {attempt.metrics?.costMicroUsd == null
                      ? '–'
                      : format.money(attempt.metrics.costMicroUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <EvalCaseDialog
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        evalCase={evalCase}
      />
      <EvalStartDialog
        open={starting}
        onOpenChange={setStarting}
        workspaceId={workspaceId}
        cases={[evalCase]}
        suites={[]}
        preselected={[evalCase.id]}
      />
    </AppPage>
  );
}

function CheckList({ title, checks }: { title: string; checks: readonly EvalAssertion[] }) {
  const t = useTranslations('evals.case');
  const wording = useEvalWording();
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {checks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {checks.map((check) => (
            <li key={check.id}>
              <span className="font-mono text-meta text-muted-foreground">{check.id}</span>{' '}
              {wording.describe(check)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
