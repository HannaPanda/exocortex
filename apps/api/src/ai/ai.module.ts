import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { PublicAiModelsController } from './ai-models.controller';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  controllers: [AiController, PublicAiModelsController, ConversationsController],
  providers: [AiService, AiModelResolverService, ConversationsService],
  exports: [AiService, AiModelResolverService, ConversationsService],
})
export class AiModule {}
