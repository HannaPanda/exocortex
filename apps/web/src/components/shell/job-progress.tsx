'use client';

import * as React from 'react';

import { Progress } from '@exocortex/ui';

import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';

interface ActiveJob {
  jobId: string;
  label: string;
  progress: number;
  state: 'running' | 'done' | 'failed';
}

/**
 * Live background-job feedback.
 *
 * Fed by `job.progress`, `job.completed` and `job.failed` events from the
 * application socket, which the worker publishes through Redis.
 */
export function JobProgressIndicator() {
  const [jobs, setJobs] = React.useState<Record<string, ActiveJob>>({});

  const upsert = React.useCallback((job: ActiveJob) => {
    setJobs((current) => ({ ...current, [job.jobId]: job }));
    if (job.state !== 'running') {
      // Keep the final state visible briefly, then clear it.
      setTimeout(() => {
        setJobs((current) => {
          const next = { ...current };
          delete next[job.jobId];
          return next;
        });
      }, 2_500);
    }
  }, []);

  useRealtimeEvent('job.progress', (event) => {
    upsert({
      jobId: event.payload.jobId,
      label: event.payload.label,
      progress: event.payload.progress,
      state: 'running',
    });
  });

  useRealtimeEvent('job.completed', (event) => {
    upsert({
      jobId: event.payload.jobId,
      label: event.payload.label,
      progress: 100,
      state: 'done',
    });
  });

  useRealtimeEvent('job.failed', (event) => {
    upsert({
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
          className="rounded-md border border-border bg-card p-2 shadow-lg"
          data-job-state={job.state}
        >
          <p className="mb-1 truncate text-xs text-muted-foreground">{job.label}</p>
          <Progress value={job.progress} label={job.label} />
        </div>
      ))}
    </div>
  );
}
