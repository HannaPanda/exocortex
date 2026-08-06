import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { CollaborationBridgeService } from './collaboration-bridge.service';
import { CollaborationTicketService } from './collaboration-ticket.service';
import { DocumentContentService } from './document-content.service';
import { DocumentCoverService } from './document-cover.service';
import { DocumentMarkdownService } from './document-markdown.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentsController, WorkspaceDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [RealtimeModule, AttachmentsModule],
  controllers: [WorkspaceDocumentsController, DocumentsController],
  providers: [
    DocumentsService,
    DocumentCoverService,
    DocumentMarkdownService,
    DocumentSnapshotService,
    DocumentContentService,
    CollaborationTicketService,
    CollaborationBridgeService,
    OutboxService,
  ],
  exports: [
    DocumentsService,
    DocumentMarkdownService,
    DocumentSnapshotService,
    DocumentContentService,
  ],
})
export class DocumentsModule {}
