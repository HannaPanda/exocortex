import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { CommentsController, DocumentCommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [RealtimeModule],
  controllers: [DocumentCommentsController, CommentsController],
  providers: [CommentsService, OutboxService],
  exports: [CommentsService],
})
export class CommentsModule {}
