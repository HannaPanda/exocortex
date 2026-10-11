import { type WorkflowJob } from '@exocortex/contracts';

import { advanceWorkflowRun } from './advance';
import { executeWorkflowNode, resumeWorkflowNode } from './execute';
import { type WorkflowRuntimeDependencies } from './shared';

/**
 * The workflow runtime (issue #161, ADR-076).
 *
 * A run is advanced one transition at a time, and each transition is written
 * before the next is scheduled. Nothing about a run lives in a process: the
 * worker that queues a node is not the one that executes it, and whichever
 * worker picks up the next job reads the rows as they are.
 *
 * - `advanceWorkflowRun` (`advance.ts`) holds the run's lock, asks
 *   `workflowProgress` what may run, records the dead nodes as skipped,
 *   queues what the limits allow and finishes the run when nothing more can
 *   happen.
 * - `executeWorkflowNode` (`execute.ts`) claims one queued attempt with a
 *   lease, calls its handler outside any transaction, and records the outcome
 *   only if the lease is still its own (`record.ts`).
 * - `resumeWorkflowNode` does the same for a waiting attempt once what it
 *   waited for has happened.
 * - `sweepWorkflowRuns` (`sweep.ts`) recovers what a dead worker or a lost
 *   job left behind.
 *
 * Waiting holds no worker: a waiting attempt is a row with `waitingOn`, and
 * the run's status is `waiting` while nothing else is in flight.
 */

export { type AdvanceResult, advanceWorkflowRun } from './advance';
export { executeWorkflowNode, resumeWorkflowNode } from './execute';
export { type WorkflowRuntimeDependencies } from './shared';

/** Handles one job of the `workflow` queue. */
export async function runWorkflowJob(
  dependencies: WorkflowRuntimeDependencies,
  job: WorkflowJob,
  startFromEvent: (job: Extract<WorkflowJob, { kind: 'start-event' }>) => Promise<void>,
): Promise<void> {
  switch (job.kind) {
    case 'advance':
      await advanceWorkflowRun(dependencies, job.runId);
      return;
    case 'execute':
      await executeWorkflowNode(dependencies, job.executionId);
      return;
    case 'resume':
      await resumeWorkflowNode(dependencies, job.executionId, job.wake);
      return;
    case 'start-event':
      await startFromEvent(job);
      return;
  }
}
