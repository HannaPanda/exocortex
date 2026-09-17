import { Module } from '@nestjs/common';

import { DocumentsModule } from '../documents/documents.module';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { PublicAiModelsController } from './ai-models.controller';
import { ConversationArchiveService } from './conversation-archive.service';
import { ConversationSearchService } from './conversation-search';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  // `DocumentsModule` so a conversation can be saved as an ordinary page
  // through the same services the editor uses (issue #69, ADR-016).
  imports: [DocumentsModule],
  controllers: [AiController, PublicAiModelsController, ConversationsController],
  providers: [
    AiService,
    AiModelResolverService,
    ConversationsService,
    ConversationSearchService,
    ConversationArchiveService,
  ],
  exports: [AiService, AiModelResolverService, ConversationsService, ConversationArchiveService],
})
export class AiModule {}
