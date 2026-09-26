import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { WorkItemsModule } from '../work-items/work-items.module';

import { AttentionController } from './attention.controller';
import { AttentionService } from './attention.service';

/**
 * What needs a person (issue #139, ADR-067).
 *
 * `WorkItemsModule`, because answering a question about a piece of work is a
 * change to that work, made in its transaction and written into its history.
 */
@Module({
  imports: [RealtimeModule, WorkItemsModule],
  controllers: [AttentionController],
  providers: [AttentionService],
})
export class AttentionModule {}
