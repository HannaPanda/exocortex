import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';

import { QUEUE_NAMES, type WorkflowJob } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { AttentionService } from '../attention/attention.service';
import { currentCorrelationId } from '../common/correlation';
import { PRISMA, QUEUES } from '../platform/platform-tokens';
import { WorkItemsService } from '../work-items/work-items.service';

/**
 * Wakes a workflow node that waits on something that changed in the API: a
 * work item (issue #162, ADR-077) or the attention item an approval asked
 * (issue #163).
 *
 * The services tell their listeners after the change is committed; this one
 * looks for an attempt waiting on that object and queues its `resume`.
 * Whether the change settles the node is the worker's decision, read from the
 * rows when the job runs, so a wake that turns out to mean nothing costs one
 * claim and the node waits on. A wake that is lost -- Redis down, the API
 * stopped between commit and enqueue -- is found by the workflow sweep within
 * a minute.
 */
@Injectable()
export class WorkflowWakeService implements OnModuleInit {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly workItems: WorkItemsService,
    private readonly attention: AttentionService,
  ) {}

  onModuleInit(): void {
    this.workItems.onStatusChange((workItemId) => this.wake(workItemId));
    this.attention.onWorkflowAnswer((attentionItemId) => this.wakeApproval(attentionItemId));
  }

  async wake(workItemId: string): Promise<void> {
    await this.resumeWaiting(['workItemId'], workItemId, { kind: 'work_item', workItemId });
  }

  async wakeApproval(attentionItemId: string): Promise<void> {
    await this.resumeWaiting(['attentionItemId'], attentionItemId, {
      kind: 'attention_item',
      attentionItemId,
    });
  }

  private async resumeWaiting(
    path: string[],
    id: string,
    wake: Extract<WorkflowJob, { kind: 'resume' }>['wake'],
  ): Promise<void> {
    const where: Prisma.WorkflowNodeExecutionWhereInput = {
      // By what the attempt waits on rather than a column, which a deletion
      // of the work item has already set to null by the time this runs.
      status: 'WAITING',
      waitingOn: { path, equals: id },
    };
    const waiting = await this.prisma.workflowNodeExecution.findMany({
      where,
      select: { id: true, runId: true },
    });
    for (const execution of waiting) {
      await this.queues.enqueue(QUEUE_NAMES.workflow, {
        kind: 'resume',
        runId: execution.runId,
        executionId: execution.id,
        wake,
        correlationId: currentCorrelationId(),
      });
    }
  }
}
