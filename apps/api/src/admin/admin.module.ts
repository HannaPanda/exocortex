import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAiModelsController } from './ai-models.controller';
import { AiModelsService } from './ai-models.service';
import { AiUsageService } from './ai-usage.service';

@Module({
  imports: [AiModule],
  controllers: [AdminController, AdminAiModelsController],
  providers: [AdminService, AiModelsService, AiUsageService],
})
export class AdminModule {}
