import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { CellFileCopyService } from './cell-file-copy.service';
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
    CellFileCopyService,
    UploadTicketsService,
    DownloadTicketsService,
    OutboxService,
  ],
  // The copy is for the services that copy a row: templates and duplicating
  // rows (issue #316).
  exports: [AttachmentsService, CellFileCopyService],
})
export class AttachmentsModule {}
