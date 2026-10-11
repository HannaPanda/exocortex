import { type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type QueueRegistry } from '@exocortex/queue';

import { runWorkflowJob } from '../workflows/runtime';
import { startWorkflowFromEvent } from '../workflows/triggers';

/**
 * The `workflow` queue (issue #161, ADR-076): one step of one run per job.
 * Everything a step needs is in the rows, so the processor is a dispatch and
 * nothing else; see `apps/worker/src/workflows/runtime.ts`.
 */
export interface WorkflowProcessorDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** For the agent node (issue #162); null without a service token. */
  apiClientFor:
    ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null;
}

export function createWorkflowProcessor(dependencies: WorkflowProcessorDependencies) {
  return async ({ payload, logger }: JobContext<typeof QUEUE_NAMES.workflow>): Promise<void> => {
    const runtime = {
      prisma: dependencies.prisma,
      queues: dependencies.queues,
      settings: (workspaceId: string) => dependencies.settings(workspaceId),
      apiClientFor: dependencies.apiClientFor,
      logger,
    };
    await runWorkflowJob(runtime, payload, async (job) => {
      await startWorkflowFromEvent({ ...runtime, queues: dependencies.queues }, job);
    });
  };
}
