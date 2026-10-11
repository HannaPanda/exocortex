import { sweepWorkflowRuns } from '../../workflows/sweep';

import { type MaintenanceTask } from './context';

/**
 * The workflow runtime's minute sweep (issue #161, ADR-076): due schedules,
 * expired leases, lost jobs, due timers and passed deadlines. The decisions
 * are in `apps/worker/src/workflows/sweep.ts`; this is the maintenance seam.
 */
export const sweepWorkflows: MaintenanceTask = async (context) => {
  const runtime = {
    prisma: context.prisma,
    queues: context.queues,
    settings: (workspaceId: string) => context.settings(workspaceId),
    logger: context.logger,
  };
  const counts = await sweepWorkflowRuns({
    ...runtime,
    triggers: runtime,
    workspaceId: context.payload.workspaceId,
  });
  if (Object.values(counts).some((count) => count > 0)) {
    context.logger.info('Workflow sweep handed work back', counts);
  }
};
