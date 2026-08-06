import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';

import { CollaborationBridgeService } from './collaboration-bridge.service';
import { CollaborationTicketService } from './collaboration-ticket.service';
import { DocumentContentService } from './document-content.service';
import { DocumentMarkdownService } from './document-markdown.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentsController, WorkspaceDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [RealtimeModule],
  controllers: [WorkspaceDocumentsController, DocumentsController],
  providers: [
    DocumentsService,
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
