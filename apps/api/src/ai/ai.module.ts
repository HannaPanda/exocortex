import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';
import { SearchModule } from '../search/search.module';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { PublicAiModelsController } from './ai-models.controller';
import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationSearchService } from './conversation-search';
import { ConversationSourcesService } from './conversation-sources.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  // `DocumentsModule` so a conversation can be saved as an ordinary page
  // through the same services the editor uses (issue #69, ADR-016).
  // `SearchModule` for the two adapters a pinned saved query is answered with
  // (issue #75); it exports both providers, nothing else is taken from it.
  imports: [DocumentsModule, SearchModule],
  controllers: [AiController, PublicAiModelsController, ConversationsController],
  providers: [
    AiService,
    AiModelResolverService,
    ConversationsService,
    ConversationSearchService,
    ConversationArchiveService,
    ConversationSourcesService,
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
