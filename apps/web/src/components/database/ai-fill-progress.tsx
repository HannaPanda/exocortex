'use client';

import { AlertCircleIcon, RotateCwIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiFillRun } from '@exocortex/contracts';
import { Button, Progress } from '@exocortex/ui';

import { useAiFills, useCancelAiFill, useRetryAiFill } from '@/lib/api/database-ai-fill-queries';

/**
 * The strip above a table while AI fills work on it (issue #237, ADR-099):
 * a line per batch still working, with its cancel, and one for the newest
 * batch that left cells open, with its retry.
 */

/** How long a finished batch that left cells open is offered for a retry. */
const RETRY_OFFER_MS = 30 * 60 * 1_000;

function isActive(run: AiFillRun): boolean {
  return run.status === 'pending' || run.status === 'running';
}

/**
 * The newest finished batch, when it left cells failed or cancelled and ended
 * a short while ago: the one a person would want to try again. Older ones are
 * still reachable through their cells' marks.
 */
function retryableRun(runs: readonly AiFillRun[], now: number): AiFillRun | null {
  const latest = runs.find((run) => !isActive(run));
  if (latest === undefined || latest.finishedAt === null) return null;
  if (latest.counts.failed + latest.counts.cancelled === 0) return null;
  return now - Date.parse(latest.finishedAt) < RETRY_OFFER_MS ? latest : null;
}

/**
 * One line per batch that is still working, with how far it is and a way to
 * stop it, and one for the newest batch that left cells open, with a way to
 * ask them again.
 */
export function AiFillProgress({ documentId, enabled }: { documentId: string; enabled: boolean }) {
  const list = useAiFills(documentId, enabled);
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const runs = list.data?.runs ?? [];
  const active = runs.filter(isActive);
  // `dataUpdatedAt` is when the list was read, so the offer is judged against
  // the same moment on every render instead of the wall clock.
  const retry = retryableRun(runs, list.dataUpdatedAt);
  const offerRetry = retry !== null && retry.id !== dismissed;
  if (active.length === 0 && !offerRetry) return null;
  return (
    <div className="grid gap-1 border-b border-border px-2 py-1.5" data-testid="ai-fill-progress">
      {active.map((run) => (
        <AiFillRunLine key={run.id} documentId={documentId} run={run} />
      ))}
      {offerRetry ? (
        <AiFillRetryLine documentId={documentId} run={retry} onDismiss={setDismissed} />
      ) : null}
    </div>
  );
}

function AiFillRunLine({ documentId, run }: { documentId: string; run: AiFillRun }) {
  const t = useTranslations('database.aiFill');
  const cancel = useCancelAiFill(documentId);
  const done = run.counts.total - run.counts.queued - run.counts.running;
  return (
    <div className="flex items-center gap-2 text-sm" data-testid={`ai-fill-run-${run.id}`}>
      <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        {t('progress', { name: run.propertyName, done, total: run.counts.total })}
      </span>
      <Progress
        className="w-32 shrink-0"
        value={run.counts.total === 0 ? 0 : (done / run.counts.total) * 100}
        label={t('progressLabel', { name: run.propertyName })}
      />
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        disabled={cancel.isPending}
        data-testid={`ai-fill-cancel-${run.id}`}
        onClick={() => cancel.mutate(run.id)}
      >
        <XIcon /> {t('cancelRun')}
      </Button>
    </div>
  );
}

function AiFillRetryLine({
  documentId,
  run,
  onDismiss,
}: {
  documentId: string;
  run: AiFillRun;
  onDismiss: (runId: string) => void;
}) {
  const t = useTranslations('database.aiFill');
  const retry = useRetryAiFill(documentId);
  const open = run.counts.failed + run.counts.cancelled;
  return (
    <div className="flex items-center gap-2 text-sm" data-testid={`ai-fill-retry-line-${run.id}`}>
      <AlertCircleIcon className="size-4 shrink-0 text-destructive-text" />
      <span className="min-w-0 truncate">
        {t('openCells', { name: run.propertyName, count: open })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        disabled={retry.isPending}
        data-testid={`ai-fill-retry-${run.id}`}
        onClick={() => retry.mutate(run.id)}
      >
        <RotateCwIcon /> {t('retryRun')}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('dismiss')}
        data-testid={`ai-fill-dismiss-${run.id}`}
        onClick={() => onDismiss(run.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}
