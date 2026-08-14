import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { OutboxService } from '../common/outbox.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { SearchModule } from '../search/search.module';

import { CollaborationBridgeService } from './collaboration-bridge.service';
import { CollaborationTicketService } from './collaboration-ticket.service';
import { DocumentActivityService } from './document-activity.service';
import { DocumentContentService } from './document-content.service';
import { DocumentCoverService } from './document-cover.service';
import { DocumentLinksService } from './document-links.service';
import { DocumentMarkdownService } from './document-markdown.service';
import { DocumentMoveService } from './document-move.service';
import { DocumentSnapshotService } from './document-snapshot.service';
import { DocumentTrashService } from './document-trash.service';
import { DocumentTreeService } from './document-tree.service';
import { DocumentsController, WorkspaceDocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';
import { RelatedDocumentsService } from './related-documents.service';

@Module({
  // `SearchModule` for its search adapter: "verwandte Notizen" is a
  // nearest-neighbour read over the same vectors the search box uses.
  imports: [RealtimeModule, AttachmentsModule, SearchModule],
  controllers: [WorkspaceDocumentsController, DocumentsController],
  providers: [
    DocumentsService,
    DocumentTreeService,
    DocumentTrashService,
    DocumentMoveService,
    DocumentCoverService,
    DocumentMarkdownService,
    DocumentSnapshotService,
    DocumentActivityService,
    DocumentContentService,
    DocumentLinksService,
    RelatedDocumentsService,
    PageLinkIdentityService,
    CollaborationTicketService,
    CollaborationBridgeService,
    OutboxService,
  ],
  exports: [
    DocumentsService,
    DocumentMarkdownService,
    DocumentSnapshotService,
    DocumentActivityService,
    DocumentContentService,
    DocumentLinksService,
    RelatedDocumentsService,
  ],
})
export class DocumentsModule {}
