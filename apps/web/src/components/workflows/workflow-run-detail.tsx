'use client';

import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  WORKFLOW_RUN_TERMINAL_STATUSES,
  type WorkflowNodeExecution,
  type WorkflowRunEvent,
  type WorkflowRunResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  ErrorState,
  LoadingState,
  Readout,
  SectionRule,
} from '@exocortex/ui';

import { useCancelWorkflowRun, useWorkflowRun } from '@/lib/api/workflow-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { type RunFormat, useRunFormat } from '../runs/run-inspector-format';
import { runInspectorHref } from '../runs/run-links';

import {
  WorkflowCanvas,
  type WorkflowNodeDecoration,
  type WorkflowSelection,
} from './workflow-canvas';
import { CanvasControls } from './workflow-canvas-controls';
import { runStatusVariant, useWorkflowWording, type WorkflowWording } from './workflow-labels';
import { attemptDurationMs, workflowRunView } from './workflow-run-view';
import { useNodeSummary } from './workflow-summaries';

/**
 * The run debugger (issue #164): the version a run started on, with the path
 * it took drawn on it, what each node did attempt by attempt, and the run's
 * history and spend.
 *
 * Everything shown is read from the run's own rows, which is also everything
 * the worker acts on, so the picture cannot disagree with what happens next.
 * A run that has not finished is read again every few seconds.
 */
export function WorkflowRunDetail({
  workspaceId,
  workflowId,
  runId,
}: {
  workspaceId: string;
  workflowId: string;
  runId: string;
}) {
  const t = useTranslations('workflows.run');
  const run = useWorkflowRun(runId);
  if (run.isPending) {
    return (
      <AppPage maxWidth="max-w-6xl">
        <LoadingState variant="skeleton" rows={6} label={t('loading')} />
      </AppPage>
    );
  }
  if (run.isError) {
    return (
      <AppPage maxWidth="max-w-6xl">
        <ErrorState
          title={t('loadFailed')}
          description={run.error.message}
          onRetry={() => void run.refetch()}
        />
      </AppPage>
    );
  }
  return (
    <ReactFlowProvider>
      <LoadedRun workspaceId={workspaceId} workflowId={workflowId} response={run.data} />
    </ReactFlowProvider>
  );
}

function LoadedRun({
  workspaceId,
  workflowId,
  response,
}: {
  workspaceId: string;
  workflowId: string;
  response: WorkflowRunResponse;
}) {
  const t = useTranslations('workflows.run');
  const wording = useWorkflowWording();
  const format = useRunFormat();
  const detail = useWorkspaceDetail(workspaceId);
  const cancel = useCancelWorkflowRun(response.run.id);
  const summary = useNodeSummary(detail.data?.members ?? []);
  const [selection, setSelection] = React.useState<WorkflowSelection>(null);
  const { run, graph } = response;
  const view = React.useMemo(() => workflowRunView(response), [response]);
  const finished = WORKFLOW_RUN_TERMINAL_STATUSES.includes(run.status);
  const role = detail.data?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';

  const decorations = React.useMemo(() => {
    const map = new Map<string, WorkflowNodeDecoration>();
    for (const node of graph.nodes) {
      const nodeView = view.nodes.get(node.id);
      map.set(node.id, {
        summary: summary(node, graph),
        badge: null,
        problems: 0,
        ...(nodeView === undefined
          ? {}
          : { runState: nodeView.state, attempts: nodeView.attempts.length }),
      });
    }
    return map;
  }, [graph, summary, view]);

  const selectedNode =
    selection?.kind === 'node' ? graph.nodes.find((node) => node.id === selection.id) : undefined;

  // Where the panel sits below the canvas, a chosen node's attempts would be
  // out of sight; bring the top of the panel up to meet the choice.
  const asideRef = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const aside = asideRef.current;
    if (selection === null || aside === null) return;
    if (aside.getBoundingClientRect().top > window.innerHeight - 80) {
      aside.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }, [selection]);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto @4xl:overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border px-4 pt-3 pb-3 @3xl:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('back')}
              title={t('back')}
              render={
                <Link href={`/arbeitsbereich/${workspaceId}/workflows/${workflowId}?tab=laeufe`} />
              }
            >
              <ArrowLeftIcon />
            </Button>
            <h1 className="exocortex-page-title min-w-0 truncate">
              {t('title', { moment: format.moment(run.createdAt) })}
            </h1>
          </div>
          {!finished && canManage ? (
            <Button
              variant="outline"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({})}
              data-testid="workflow-run-cancel"
            >
              {t('cancel')}
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="workflow-run-state">
          <Badge variant={runStatusVariant(run.status)} data-testid="workflow-run-status">
            {wording.runStatus(run.status)}
          </Badge>
          <Badge variant="outline">{wording.origin(run.origin)}</Badge>
          <span className="text-muted-foreground">{t('version', { version: run.version })}</span>
        </div>
        {run.errorCode === null ? null : (
          <Alert variant={run.status === 'cancelled' ? 'default' : 'destructive'}>
            <AlertDescription>
              <span className="exocortex-numeric mr-2">{run.errorCode}</span>
              {run.errorMessage}
            </AlertDescription>
          </Alert>
        )}
        {cancel.error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{cancel.error.message}</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
        <div
          className="relative h-[55dvh] min-h-80 shrink-0 @4xl:h-auto @4xl:min-h-0 @4xl:flex-1 @4xl:shrink"
          data-testid="workflow-run-canvas"
        >
          <WorkflowCanvas
            graph={graph}
            mode="view"
            selection={selection}
            onSelect={setSelection}
            decorations={decorations}
            problemEdgeIds={EMPTY}
            takenEdgeIds={view.takenEdgeIds}
            label={t('canvasLabel')}
          >
            <CanvasControls />
          </WorkflowCanvas>
        </div>
        <aside
          ref={asideRef}
          className="flex shrink-0 flex-col gap-6 border-t border-border bg-surface p-4 @4xl:w-96 @4xl:overflow-y-auto @4xl:border-t-0 @4xl:border-l"
          aria-label={t('panelLabel')}
        >
          {selectedNode === undefined ? (
            <RunSummary response={response} format={format} />
          ) : (
            <NodeAttempts
              workspaceId={workspaceId}
              title={selectedNode.label ?? selectedNode.id}
              typeLabel={wording.type(selectedNode.type)}
              attempts={view.nodes.get(selectedNode.id)?.attempts ?? []}
              state={wording.nodeState(view.nodes.get(selectedNode.id)?.state ?? 'untouched')}
              onBack={() => setSelection(null)}
              format={format}
              wording={wording}
            />
          )}
          <RunHistory
            events={response.events}
            origin={run.createdAt}
            format={format}
            wording={wording}
          />
        </aside>
      </div>
    </div>
  );
}

const EMPTY: ReadonlySet<string> = new Set();

function subscribeToSecond(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, 1_000);
  return () => window.clearInterval(timer);
}

function secondSnapshot(): number {
  return Math.floor(Date.now() / 1_000) * 1_000;
}

/**
 * The current second, or null on the server: a running step's duration
 * counts up between two reads of the run. An external store, because the
 * clock is not this component's state.
 */
function useNow(): number | null {
  return React.useSyncExternalStore<number | null>(subscribeToSecond, secondSnapshot, () => null);
}

function RunSummary({ response, format }: { response: WorkflowRunResponse; format: RunFormat }) {
  const t = useTranslations('workflows.run');
  const modeWording = useWorkflowWording();
  const { run, progress } = response;
  const limits = run.limits;
  const now = useNow();
  const started = run.startedAt === null ? null : Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  return (
    <section className="flex flex-col gap-1.5" data-testid="workflow-run-summary">
      <SectionRule>{t('summary')}</SectionRule>
      <Readout
        label={t('spent')}
        value={
          limits === null
            ? format.money(run.spentMicroUsd)
            : t('ofBudget', {
                spent: format.money(run.spentMicroUsd),
                budget: format.money(limits.budgetMicroUsd),
              })
        }
        tone={run.finishedAt === null ? 'live' : 'default'}
      />
      <Readout
        label={t('steps')}
        value={
          limits === null
            ? format.count(run.nodeExecutionCount)
            : t('ofLimit', {
                count: format.count(run.nodeExecutionCount),
                limit: format.count(limits.maxNodeExecutions),
              })
        }
      />
      <Readout
        label={t('duration')}
        value={started === null || end === null ? '–' : format.duration(Math.max(0, end - started))}
      />
      {run.deadlineAt === null || run.finishedAt !== null ? null : (
        <Readout label={t('deadline')} value={format.moment(run.deadlineAt)} />
      )}
      <Readout
        label={t('writeMode')}
        value={run.writeMode === null ? t('writeModeNone') : modeWording.writeMode(run.writeMode)}
      />
      <Readout label={t('startedBy')} value={run.startedBy?.name ?? t('unknown')} />
      {run.chainDepth > 0 ? (
        <Readout label={t('chainDepth')} value={format.count(run.chainDepth)} />
      ) : null}
      {progress.active.length > 0 ? (
        <Readout label={t('active')} value={progress.active.join(', ')} tone="live" />
      ) : null}
      {progress.runnable.length > 0 ? (
        <Readout label={t('runnable')} value={progress.runnable.join(', ')} />
      ) : null}
      {run.summary === null ? null : (
        <p className="mt-2 text-sm" data-testid="workflow-run-end-summary">
          {run.summary}
        </p>
      )}
      <p className="exocortex-numeric mt-2 text-micro text-muted-foreground">
        {t('ids', { runId: run.id, correlationId: run.correlationId ?? '–' })}
      </p>
    </section>
  );
}

function NodeAttempts({
  workspaceId,
  title,
  typeLabel,
  attempts,
  state,
  onBack,
  format,
  wording,
}: {
  workspaceId: string;
  title: string;
  typeLabel: string;
  attempts: readonly WorkflowNodeExecution[];
  state: string;
  onBack: () => void;
  format: RunFormat;
  wording: WorkflowWording;
}) {
  const t = useTranslations('workflows.run');
  const now = useNow();
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-run-node">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">
            {typeLabel} · {state}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('showRun')}
        </Button>
      </div>
      {attempts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noAttempts')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {attempts.map((attempt) => {
            const duration = now === null ? null : attemptDurationMs(attempt, now);
            return (
              <li
                key={attempt.id}
                className="flex flex-col gap-1.5"
                data-testid="workflow-run-attempt"
              >
                <SectionRule as="h3" trailing={wording.nodeState(attempt.status)}>
                  {t('attempt', { attempt: attempt.attempt })}
                </SectionRule>
                <Readout label={t('queuedAt')} value={format.moment(attempt.queuedAt)} />
                {duration === null ? null : (
                  <Readout label={t('took')} value={format.duration(duration)} />
                )}
                {attempt.firedHandles.length === 0 ? null : (
                  <Readout
                    label={t('firedHandles')}
                    value={attempt.firedHandles.map((handle) => wording.handle(handle)).join(', ')}
                  />
                )}
                {attempt.errorClass === null ? null : (
                  <Alert variant="destructive">
                    <AlertDescription>
                      <span className="block font-medium">
                        {wording.errorClass(attempt.errorClass)}
                        {attempt.errorCode === null ? null : (
                          <span className="exocortex-numeric ml-2 font-normal">
                            {attempt.errorCode}
                          </span>
                        )}
                      </span>
                      {attempt.errorMessage}
                    </AlertDescription>
                  </Alert>
                )}
                {attempt.waitingOn === null ? null : (
                  <p className="text-sm">
                    {attempt.waitingOn.kind === 'timer'
                      ? t('waitingTimer', { until: format.moment(attempt.waitingOn.until) })
                      : attempt.waitingOn.kind === 'work_item'
                        ? t('waitingWorkItem')
                        : t('waitingAttention')}{' '}
                    {attempt.waitingOn.kind === 'attention_item' ? (
                      <Link href="/wartet" className="text-primary-text hover:underline">
                        {t('openAttention')}
                      </Link>
                    ) : null}
                  </p>
                )}
                <div className="flex flex-wrap gap-3 text-sm">
                  {attempt.workItemId === null ? null : (
                    <Link
                      href={`/arbeitsbereich/${workspaceId}/auftraege/${attempt.workItemId}`}
                      className="text-primary-text hover:underline"
                      data-testid="workflow-run-work-item"
                    >
                      {t('openWorkItem')}
                    </Link>
                  )}
                  {attempt.aiRunId === null ? null : (
                    <Link
                      href={runInspectorHref(workspaceId, attempt.aiRunId)}
                      className="text-primary-text hover:underline"
                    >
                      {t('openAiRun')}
                    </Link>
                  )}
                </div>
                {attempt.output === null || attempt.output === undefined ? null : (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t('output')}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-sunken p-2 font-mono text-xs whitespace-pre-wrap">
                      {JSON.stringify(attempt.output, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** The run's history in order: what happened, to which node, when. */
function RunHistory({
  events,
  origin,
  format,
  wording,
}: {
  events: readonly WorkflowRunEvent[];
  origin: string;
  format: RunFormat;
  wording: WorkflowWording;
}) {
  const t = useTranslations('workflows.run');
  const tEvents = useTranslations('workflows.events');
  return (
    <section className="flex flex-col gap-2" data-testid="workflow-run-history">
      <SectionRule trailing={format.count(events.length)}>{t('history')}</SectionRule>
      <ol className="flex flex-col gap-0.5 text-sm">
        {events.map((event) => {
          const handle = typeof event.detail?.handle === 'string' ? event.detail.handle : null;
          const code = typeof event.detail?.code === 'string' ? event.detail.code : null;
          return (
            <li key={event.sequence} className="flex items-baseline gap-2">
              <span className="exocortex-numeric w-16 shrink-0 text-micro text-muted-foreground">
                {format.offset(event.at, origin)}
              </span>
              <span className="min-w-0">
                {tEvents(event.type.replace('.', '_') as 'run_started')}
                {event.nodeId === null ? null : (
                  <span className="exocortex-numeric ml-1 text-muted-foreground">
                    {event.nodeId}
                  </span>
                )}
                {handle === null ? null : (
                  <span className="ml-1 text-muted-foreground">→ {wording.handle(handle)}</span>
                )}
                {code === null ? null : (
                  <span className="exocortex-numeric ml-1 text-muted-foreground">{code}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
