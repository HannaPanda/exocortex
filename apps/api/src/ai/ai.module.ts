import { Module } from '@nestjs/common';

import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { PublicAiModelsController } from './ai-models.controller';

@Module({
  controllers: [AiController, PublicAiModelsController],
  providers: [AiService, AiModelResolverService],
  exports: [AiService, AiModelResolverService],
})
export class AiModule {}
