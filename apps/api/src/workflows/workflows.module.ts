import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflows (issues #160 and #161, ADR-075, ADR-076): definitions,
 * immutable versions, starting and cancelling runs, and reading their state.
 * Executing runs is the worker's.
 */
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowRunsService, OutboxService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
