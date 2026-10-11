import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { currentCorrelationId } from '../common/correlation';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { WorkItemsService } from '../work-items/work-items.service';

/**
 * Wakes a workflow node that waits on a work item (issue #162, ADR-077).
 *
 * The work item service tells its listeners after every committed change
 * that may have moved a status, and after a deletion; this one looks for an
 * attempt waiting on that item and queues its `resume`. Whether the change
 * completes the node is the worker's decision, read from the rows when the
 * job runs, so a wake that turns out to mean nothing costs one claim and the
 * node waits on. A wake that is lost -- Redis down, the API stopped between
 * commit and enqueue -- is found by the workflow sweep within a minute.
 */
@Injectable()
export class WorkflowWakeService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly workItems: WorkItemsService,
  ) {}

  onModuleInit(): void {
    this.workItems.onStatusChange((workItemId) => this.wake(workItemId));
  }

  async wake(workItemId: string): Promise<void> {
    const waiting = await this.prisma.workflowNodeExecution.findMany({
      // By what the attempt waits on rather than its `workItemId` column,
      // which a deletion has already set to null by the time this runs.
      where: { status: 'WAITING', waitingOn: { path: ['workItemId'], equals: workItemId } },
      select: { id: true, runId: true },
    });
    for (const execution of waiting) {
      await this.queues.enqueue(QUEUE_NAMES.workflow, {
        kind: 'resume',
        runId: execution.runId,
        executionId: execution.id,
        wake: { kind: 'work_item', workItemId },
        correlationId: currentCorrelationId(),
      });
    }
  }
}
