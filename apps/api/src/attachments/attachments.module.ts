import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { CellFilesService } from './cell-files.service';
import { DownloadTicketsController } from './download-tickets.controller';
import { DownloadTicketsService } from './download-tickets.service';
import { UploadTicketsController } from './upload-tickets.controller';
import { UploadTicketsService } from './upload-tickets.service';

@Module({
  // A file uploaded into a database cell tells open tables (issue #245).
  imports: [RealtimeModule],
  controllers: [AttachmentsController, UploadTicketsController, DownloadTicketsController],
  providers: [
    AttachmentsService,
    CellFilesService,
    UploadTicketsService,
    DownloadTicketsService,
    OutboxService,
  ],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
