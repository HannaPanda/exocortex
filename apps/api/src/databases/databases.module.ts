import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { OutboxService } from '../common/outbox.service';
import { DocumentsModule } from '../documents/documents.module';
import { RealtimeModule } from '../realtime/realtime.module';

import { AiFillController } from './ai-fill/ai-fill.controller';
import { AiFillService } from './ai-fill/ai-fill.service';
import { AiFillConfigService } from './ai-fill/ai-fill-config.service';
import { AiFillWorkerService } from './ai-fill/ai-fill-worker.service';
import { DatabasePropertiesController } from './database-properties.controller';
import { DatabasePropertiesService } from './database-properties.service';
import { DatabaseRowActionsService } from './database-row-actions.service';
import { DatabaseRowsController } from './database-rows.controller';
import { DatabaseRowsService } from './database-rows.service';
import { DatabaseViewsController } from './database-views.controller';
import { DatabaseViewsService } from './database-views.service';

@Module({
  // `AiModule` for the model a column's AI fill is started with (issue #237).
  imports: [RealtimeModule, DocumentsModule, AiModule],
  controllers: [
    DatabasePropertiesController,
    DatabaseViewsController,
    DatabaseRowsController,
    AiFillController,
  ],
  providers: [
    AiFillConfigService,
    AiFillService,
    AiFillWorkerService,
    DatabasePropertiesService,
    DatabaseViewsService,
    DatabaseRowsService,
    DatabaseRowActionsService,
    OutboxService,
  ],
  // The entity layer provisions its own database and its two columns through
  // the ordinary schema service (issue #47), so the checks are the same ones a
  // person adding a column passes.
  exports: [DatabasePropertiesService, DatabaseRowsService],
})
export class DatabasesModule {}
