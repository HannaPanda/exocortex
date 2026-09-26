import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { WorkItemsController } from './work-items.controller';
import { WorkItemsService } from './work-items.service';

/**
 * Delegated work (issue #138, ADR-066).
 *
 * `AiModule` for the conversation a run is started in: an attempt at a work
 * item is an ordinary chat turn with its run tagged, not a second way into
 * the queue.
 */
@Module({
  imports: [AiModule, RealtimeModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService],
  exports: [WorkItemsService],
})
export class WorkItemsModule {}
