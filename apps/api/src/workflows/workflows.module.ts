import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { WorkItemsModule } from '../work-items/work-items.module';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowWakeService } from './workflow-wake.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflows (issues #160 and #161, ADR-075, ADR-076): definitions,
 * immutable versions, starting and cancelling runs, and reading their state.
 * Executing runs is the worker's; waking a node that waits on a work item
 * is this module's (issue #162), because the API is where the item changes.
 */
@Module({
  imports: [WorkItemsModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowRunsService, WorkflowWakeService, OutboxService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
