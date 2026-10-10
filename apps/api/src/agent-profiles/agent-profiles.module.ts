import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { AgentProfilesController } from './agent-profiles.controller';
import { AgentProfilesService } from './agent-profiles.service';

/**
 * Agent profiles (issue #143, ADR-071). Exported for the work items, which
 * check that a profile they are given belongs to their workspace.
 */
@Module({
  controllers: [AgentProfilesController],
  providers: [AgentProfilesService, OutboxService],
  exports: [AgentProfilesService],
})
export class AgentProfilesModule {}
