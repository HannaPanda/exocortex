'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiRun, type AiRunInspection } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  ErrorState,
  LoadingState,
  Readout,
  SectionRule,
} from '@exocortex/ui';

import { useAiRunInspection } from '@/lib/api/ai-queries';

import { EvalFromRunButton } from '../evals/eval-from-run';

import { ContextComposition, ToolResults } from './run-inspector-context';
import { type RunFormat, useRunFormat } from './run-inspector-format';
import { RunTimeline } from './run-inspector-timeline';
import { runInspectorHref } from './run-links';

function statusVariant(
  status: AiRun['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'default';
  if (status === 'pending' || status === 'running') return 'secondary';
  if (status === 'cancelled') return 'outline';
  return 'destructive';
}

function Summary({ inspection, format }: { inspection: AiRunInspection; format: RunFormat }) {
  const t = useTranslations('runInspector.summary');
  const { summary } = inspection;
  const cost =
    summary.providerCostMicroUsd !== null
      ? format.money(summary.providerCostMicroUsd)
      : summary.estimatedCostMicroUsd !== null
        ? t('costEstimated', { cost: format.money(summary.estimatedCostMicroUsd) })
        : t('unknown');
  return (
    <section className="flex flex-col gap-3">
      <SectionRule>{t('heading')}</SectionRule>
      <div className="flex flex-col gap-1.5" data-testid="run-summary">
        <Readout
          label={t('duration')}
          value={summary.durationMs === null ? t('unknown') : format.duration(summary.durationMs)}
        />
        <Readout label={t('turns')} value={format.count(summary.turns)} />
        <Readout
          label={t('toolCalls')}
          value={t('toolCallsValue', {
            count: format.count(summary.toolCalls),
            failed: summary.failedToolCalls,
          })}
        />
        <Readout
          label={t('providers')}
          value={summary.providers.length === 0 ? t('providersNone') : summary.providers.join(', ')}
        />
        <Readout label={t('providerSwitches')} value={format.count(summary.providerSwitches)} />
        <Readout
          label={t('tokens')}
          value={
            summary.inputTokens === null || summary.outputTokens === null
              ? t('unknown')
              : t('tokensValue', {
                  input: format.count(summary.inputTokens),
                  output: format.count(summary.outputTokens),
                })
          }
          note={
            summary.cachedInputTokens === null || summary.cachedInputTokens === 0
              ? undefined
              : t('tokensCached', { cached: format.count(summary.cachedInputTokens) })
          }
        />
        <Readout label={t('cost')} value={cost} />
      </div>
    </section>
  );
}

function TraceIds({ inspection }: { inspection: AiRunInspection }) {
  const t = useTranslations('runInspector.trace');
  return (
    <section className="flex flex-col gap-3">
      <SectionRule>{t('heading')}</SectionRule>
      <div className="flex flex-col gap-1.5">
        <Readout
          label={t('correlationId')}
          value={
            <code className="font-mono text-meta">
              {inspection.trace.correlationId ?? t('none')}
            </code>
          }
        />
        <Readout
          label={t('traceId')}
          value={
            <code className="font-mono text-meta">{inspection.trace.traceId ?? t('none')}</code>
          }
          note={t('hint')}
        />
      </div>
    </section>
  );
}

function InspectionView({ inspection }: { inspection: AiRunInspection }) {
  const t = useTranslations('runInspector.page');
  const tStatus = useTranslations('runInspector.status');
  const router = useRouter();
  const format = useRunFormat();
  const { run } = inspection;
  const live = run.status === 'pending' || run.status === 'running';

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6" data-testid="run-inspector">
      <button
        type="button"
        onClick={() => router.back()}
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        {t('back')}
      </button>

      <div className="flex flex-col gap-2">
        <h1 className="exocortex-page-title">{t('heading')}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={statusVariant(run.status)}>{tStatus(run.status)}</Badge>
          <span>{t('subheading', { model: run.model, moment: format.moment(run.createdAt) })}</span>
          {run.conversationId === null ? null : (
            <Link href={`/chats?fortsetzen=${run.conversationId}`} className="hover:underline">
              {t('openConversation')}
            </Link>
          )}
          {/* A finished run can be kept as a task to measure the next ones with (issue #146). */}
          {live ? null : <EvalFromRunButton workspaceId={run.workspaceId} runId={run.id} />}
        </div>
        <p className="text-meta text-muted-foreground">{t('privacy')}</p>
      </div>

      {live ? (
        <Alert>
          <AlertDescription>{t('running')}</AlertDescription>
        </Alert>
      ) : null}
      {inspection.recorded ? null : (
        <Alert>
          <AlertDescription>{t('notRecorded')}</AlertDescription>
        </Alert>
      )}
      {inspection.eventsCapped ? (
        <Alert>
          <AlertDescription>{t('capped')}</AlertDescription>
        </Alert>
      ) : null}

      <Summary inspection={inspection} format={format} />
      <ContextComposition inspection={inspection} format={format} />
      <ToolResults inspection={inspection} format={format} />
      <RunTimeline inspection={inspection} format={format} />
      <TraceIds inspection={inspection} />
    </AppPage>
  );
}

/** The run inspector (issue #145, ADR-073): what one run did and what its prompt was made of. */
export function RunInspectorPage({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const t = useTranslations('runInspector.page');
  const router = useRouter();
  const query = useAiRunInspection(runId);
  const actualWorkspaceId = query.data?.run.workspaceId ?? null;
  // An address with the wrong workspace in it is corrected rather than shown
  // under a shell that describes a different workspace than the run's.
  React.useEffect(() => {
    if (actualWorkspaceId !== null && actualWorkspaceId !== workspaceId) {
      router.replace(runInspectorHref(actualWorkspaceId, runId));
    }
  }, [router, actualWorkspaceId, workspaceId, runId]);
  if (query.isPending) return <LoadingState variant="skeleton" rows={8} label={t('loading')} />;
  if (query.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void query.refetch()} />;
  }
  return <InspectionView inspection={query.data} />;
}
