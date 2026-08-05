import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, OutboxService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
