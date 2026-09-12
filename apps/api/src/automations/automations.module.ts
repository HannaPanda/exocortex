import { Module } from '@nestjs/common';

import { AutomationDispatchService } from './automation-dispatch.service';
import { AutomationsController, WorkspaceAutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';

/**
 * Automations (issue #50, ADR-024).
 *
 * `AutomationDispatchService` is exported because queueing a firing is not only
 * something a request does: it is the same act the outbox dispatcher performs
 * when an event matches a rule, and both have to write the run row the same way
 * or the log stops meaning one thing.
 */
@Module({
  controllers: [WorkspaceAutomationsController, AutomationsController],
  providers: [AutomationsService, AutomationDispatchService],
  exports: [AutomationsService, AutomationDispatchService],
})
export class AutomationsModule {}
