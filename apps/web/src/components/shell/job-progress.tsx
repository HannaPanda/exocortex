'use client';

import * as React from 'react';

import { Progress } from '@exocortex/ui';

import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/** A running job is only shown once it has been running longer than this. */
const SHOW_DELAY_MS = 1_000;
/** A failed job stays visible this long after it was reported, then clears. */
const FAILED_VISIBLE_MS = 2_500;

interface ActiveJob {
  jobId: string;
  label: string;
  progress: number;
  state: 'running' | 'failed';
}

/**
 * Live background-job feedback.
 *
 * Fed by `job.progress`, `job.completed` and `job.failed` events from the
 * application socket, which the worker publishes through Redis.
 *
 * Successful jobs never render (GH issue #5): the result is already visible
 * on the page, so a "processed" card would only ever sit in the way. Running
 * jobs are held back for `SHOW_DELAY_MS` so a materialization that finishes
 * within that window never produces a card either. Failed jobs still show
 * immediately and linger for `FAILED_VISIBLE_MS`, unchanged from before.
 */
export function JobProgressIndicator() {
  const [jobs, setJobs] = React.useState<Record<string, ActiveJob>>({});

  // Bookkeeping lives in refs, not state: it must survive across renders
  // without re-rendering itself, and every timer it creates is cleared on
  // unmount, so no callback ever fires (and calls setJobs) after that.
  const visibleIds = React.useRef(new Set<string>());
  // Latest snapshot for a job that is running but not shown yet.
  const pending = React.useRef(new Map<string, ActiveJob>());
  const showTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const hideTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  React.useEffect(
    () => () => {
      for (const timer of showTimers.current.values()) clearTimeout(timer);
      for (const timer of hideTimers.current.values()) clearTimeout(timer);
      showTimers.current.clear();
      hideTimers.current.clear();
      pending.current.clear();
    },
    [],
  );

  const showJob = React.useCallback((job: ActiveJob) => {
    visibleIds.current.add(job.jobId);
    setJobs((current) => ({ ...current, [job.jobId]: job }));
  }, []);

  const hideJob = React.useCallback((jobId: string) => {
    if (!visibleIds.current.has(jobId)) return;
    visibleIds.current.delete(jobId);
    setJobs((current) => {
      if (!(jobId in current)) return current;
      const next = { ...current };
      delete next[jobId];
      return next;
    });
  }, []);

  const cancelShowTimer = React.useCallback((jobId: string) => {
    const timer = showTimers.current.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      showTimers.current.delete(jobId);
    }
    pending.current.delete(jobId);
  }, []);

  const cancelHideTimer = React.useCallback((jobId: string) => {
    const timer = hideTimers.current.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      hideTimers.current.delete(jobId);
    }
  }, []);

  const handleRunning = React.useCallback(
    (job: ActiveJob) => {
      if (visibleIds.current.has(job.jobId)) {
        showJob(job);
        return;
      }
      // Keep the latest snapshot so the eventual reveal shows current
      // progress, not the one from a second ago. Don't restart the timer if
      // one is already ticking for this job.
      pending.current.set(job.jobId, job);
      if (showTimers.current.has(job.jobId)) return;
      const timer = setTimeout(() => {
        showTimers.current.delete(job.jobId);
        const latest = pending.current.get(job.jobId);
        pending.current.delete(job.jobId);
        if (latest !== undefined) showJob(latest);
      }, SHOW_DELAY_MS);
      showTimers.current.set(job.jobId, timer);
    },
    [showJob],
  );

  const handleCompleted = React.useCallback(
    (jobId: string) => {
      // Successful jobs never render: cancel a pending reveal, and clear an
      // already-visible card immediately instead of leaving it up.
      cancelShowTimer(jobId);
      hideJob(jobId);
    },
    [cancelShowTimer, hideJob],
  );

  const handleFailed = React.useCallback(
    (job: ActiveJob) => {
      // A failure is always worth seeing, even if the job never ran long
      // enough to clear the show delay.
      cancelShowTimer(job.jobId);
      showJob(job);
      cancelHideTimer(job.jobId);
      const timer = setTimeout(() => {
        hideTimers.current.delete(job.jobId);
        hideJob(job.jobId);
      }, FAILED_VISIBLE_MS);
      hideTimers.current.set(job.jobId, timer);
    },
    [cancelShowTimer, cancelHideTimer, showJob, hideJob],
  );

  useRealtimeEvent('job.progress', (event) => {
    handleRunning({
      jobId: event.payload.jobId,
      label: event.payload.label,
      progress: event.payload.progress,
      state: 'running',
    });
  });

  useRealtimeEvent('job.completed', (event) => {
    handleCompleted(event.payload.jobId);
  });

  useRealtimeEvent('job.failed', (event) => {
    handleFailed({
      jobId: event.payload.jobId,
      label: 'Hintergrundaufgabe fehlgeschlagen',
      progress: 100,
      state: 'failed',
    });
  });

  const active = Object.values(jobs);
  if (active.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-64 flex-col gap-2"
      data-testid="job-progress"
      aria-live="polite"
    >
      {active.map((job) => (
        <div
          key={job.jobId}
          className="rounded-md border border-border bg-popover p-2 shadow-md"
          data-job-state={job.state}
        >
          <p className="mb-1 truncate text-xs text-muted-foreground">{job.label}</p>
          <Progress value={job.progress} label={job.label} />
        </div>
      ))}
    </div>
  );
}
