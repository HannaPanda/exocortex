import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { DownloadTicketsController } from './download-tickets.controller';
import { DownloadTicketsService } from './download-tickets.service';
import { UploadTicketsController } from './upload-tickets.controller';
import { UploadTicketsService } from './upload-tickets.service';

@Module({
  controllers: [AttachmentsController, UploadTicketsController, DownloadTicketsController],
  providers: [AttachmentsService, UploadTicketsService, DownloadTicketsService, OutboxService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
