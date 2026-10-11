import { Module } from '@nestjs/common';

import { AttentionModule } from '../attention/attention.module';
import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { WorkItemsModule } from '../work-items/work-items.module';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowWakeService } from './workflow-wake.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflows (issues #160 and #161, ADR-075, ADR-076): definitions,
 * immutable versions, starting and cancelling runs, and reading their state.
 * Executing runs is the worker's; waking a node that waits on a work item
 * or on an approval is this module's (issues #162, #163), because the API is
 * where the item changes and where the person answers.
 */
@Module({
  imports: [WorkItemsModule, AttentionModule, RealtimeModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowRunsService, WorkflowWakeService, OutboxService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
