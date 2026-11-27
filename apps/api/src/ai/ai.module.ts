import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { DocumentsModule } from '../documents/documents.module';
import { SearchModule } from '../search/search.module';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { PublicAiModelsController } from './ai-models.controller';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationSearchService } from './conversation-search';
import { ConversationSourcesService } from './conversation-sources.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { RunChangesService } from './run-changes.service';
import { RunInspectionService } from './run-inspection.service';

@Module({
  // `DocumentsModule` so a conversation can be saved as an ordinary page
  // through the same services the editor uses (issue #69, ADR-016).
  // `SearchModule` for the two adapters a pinned saved query is answered with
  // (issue #75); it exports both providers, nothing else is taken from it.
  // `AttachmentsModule` for the upload a chat file goes through (issue #223).
  imports: [DocumentsModule, SearchModule, AttachmentsModule],
  controllers: [AiController, PublicAiModelsController, ConversationsController],
  providers: [
    AiService,
    AiModelResolverService,
    ChatAttachmentsService,
    ConversationsService,
    ConversationSearchService,
    ConversationArchiveService,
    ConversationSourcesService,
    RunInspectionService,
    RunChangesService,
  ],
  exports: [
    AiService,
    AiModelResolverService,
    ConversationsService,
    ConversationArchiveService,
    ConversationSourcesService,
  ],
})
export class AiModule {}
