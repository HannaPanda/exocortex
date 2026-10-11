import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Agent workflows (issue #160, ADR-075): definitions, immutable versions and
 * the persisted state of their runs. The runs service is exported for the
 * runtime that will start and advance them (issue #161).
 */
@Module({
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowRunsService, OutboxService],
  exports: [WorkflowRunsService],
})
export class WorkflowsModule {}
